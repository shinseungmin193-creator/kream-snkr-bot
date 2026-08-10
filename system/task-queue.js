const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const STATUS = Object.freeze({
    WAITING: '대기중',
    RUNNING: '실행중',
    COMPLETED: '완료',
    FAILED: '실패',
    CANCELED: '취소'
});

const STATUS_CODE = Object.freeze({
    [STATUS.WAITING]: 'waiting',
    [STATUS.RUNNING]: 'running',
    [STATUS.COMPLETED]: 'completed',
    [STATUS.FAILED]: 'failed',
    [STATUS.CANCELED]: 'cancelled'
});

class DuplicateTaskError extends Error {
    constructor(type) {
        super('이미 실행중입니다.');
        this.name = 'DuplicateTaskError';
        this.code = 'DUPLICATE_TASK';
        this.type = type;
    }
}

class TaskNotFoundError extends Error {
    constructor(id) {
        super(`작업을 찾을 수 없습니다: ${id}`);
        this.name = 'TaskNotFoundError';
        this.code = 'TASK_NOT_FOUND';
    }
}

class QueueStoppingError extends Error {
    constructor() {
        super('작업 중지 처리 중입니다. 완료 후 다시 시도하세요.');
        this.name = 'QueueStoppingError';
        this.code = 'QUEUE_STOPPING';
    }
}

class TaskQueue extends EventEmitter {
    constructor({ recentLimit = 50, clock = () => new Date(), idFactory = () => randomUUID() } = {}) {
        super();
        this.recentLimit = recentLimit;
        this.clock = clock;
        this.idFactory = idFactory;
        this.pending = [];
        this.current = null;
        this.recent = [];
        this.processing = false;
        this.stopping = false;
        this.stopPromise = null;
    }

    enqueue({ type, label, requestIp, run, onCancel = null, metadata = {} }) {
        if (!type || typeof run !== 'function') throw new Error('작업 종류와 실행 함수가 필요합니다.');
        if (this.stopping) throw new QueueStoppingError();
        if (this.hasActiveType(type)) throw new DuplicateTaskError(type);

        const registeredAt = this.clock().toISOString();
        const job = {
            id: this.idFactory(),
            type: String(type),
            label: String(label || type),
            requestIp: String(requestIp || 'unknown').slice(0, 80),
            registeredAt,
            startedAt: null,
            endedAt: null,
            updatedAt: registeredAt,
            status: STATUS.WAITING,
            progress: {
                current: 0,
                total: null,
                percent: 0,
                etaSeconds: null,
                message: '대기 중',
                currentStep: '등록',
                updatedAt: registeredAt,
                recentMessages: ['대기 중']
            },
            progressTiming: null,
            durationSeconds: null,
            error: null,
            result: null,
            cancelRequested: false,
            metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
            run,
            onCancel
        };

        this.pending.push(job);
        this.emit('registered', this.toPublic(job));
        this.emitChanged();
        queueMicrotask(() => this.processNext());
        return this.toPublic(job);
    }

    hasActiveType(type) {
        return Boolean(
            (this.current && this.current.type === type) ||
            this.pending.some(job => job.type === type)
        );
    }

    get(id) {
        const job = (this.current?.id === id && this.current) ||
            this.pending.find(item => item.id === id) ||
            this.recent.find(item => item.id === id);
        return job ? this.toPublic(job) : null;
    }

    getSnapshot() {
        return {
            concurrency: 1,
            stopping: this.stopping,
            current: this.current ? this.toPublic(this.current) : null,
            waiting: this.pending.map(job => this.toPublic(job)),
            recent: this.recent.slice(0, this.recentLimit).map(job => this.toPublic(job))
        };
    }

    reportProgress(jobId, progress = {}) {
        if (!this.current || this.current.id !== jobId) return false;
        const job = this.current;
        const previous = job.progress;
        const now = this.clock();
        const current = Math.max(0, Number(progress.current ?? previous.current) || 0);
        let total = previous.total;
        if (Object.prototype.hasOwnProperty.call(progress, 'total')) {
            total = progress.total === null || progress.total === undefined || progress.total === ''
                ? null
                : Math.max(0, Number(progress.total) || 0);
        }
        const calculated = total > 0
            ? Math.min(100, Math.max(current > 0 && current < total ? 1 : 0, Math.round((current / total) * 100)))
            : previous.percent;
        const percent = Math.max(0, Math.min(100, Number(progress.percent ?? calculated) || 0));
        const currentStep = String(progress.step ?? progress.currentStep ?? previous.currentStep ?? '').slice(0, 100);
        const etaKey = String(progress.etaKey ?? currentStep).slice(0, 100);
        const message = String(progress.message ?? previous.message ?? '').slice(0, 200);
        const timingChanged = !job.progressTiming ||
            job.progressTiming.etaKey !== etaKey ||
            job.progressTiming.total !== total ||
            current < previous.current;
        if (timingChanged) {
            job.progressTiming = {
                etaKey,
                total,
                startedAtMs: now.getTime(),
                startCurrent: current
            };
        }
        let etaSeconds = null;

        const completedUnits = current - job.progressTiming.startCurrent;
        if (total > 0 && completedUnits > 0 && current < total) {
            const elapsed = Math.max(0, (now.getTime() - job.progressTiming.startedAtMs) / 1000);
            etaSeconds = Math.max(0, Math.round((elapsed / completedUnits) * (total - current)));
        } else if (current >= total && total > 0) {
            etaSeconds = 0;
        }

        const recentMessages = [...(previous.recentMessages || [])];
        if (message && recentMessages[recentMessages.length - 1] !== message) recentMessages.push(message);
        const updatedAt = now.toISOString();

        job.progress = {
            current,
            total,
            percent,
            etaSeconds,
            message,
            currentStep,
            updatedAt,
            recentMessages: recentMessages.slice(-5)
        };
        job.updatedAt = updatedAt;
        this.emit('progress', this.toPublic(job));
        this.emitChanged();
        return true;
    }

    async cancel(id) {
        const waitingIndex = this.pending.findIndex(job => job.id === id);
        if (waitingIndex >= 0) {
            const [job] = this.pending.splice(waitingIndex, 1);
            job.status = STATUS.CANCELED;
            job.endedAt = this.clock().toISOString();
            job.updatedAt = job.endedAt;
            job.durationSeconds = 0;
            job.progress.message = '사용자 취소';
            job.progress.currentStep = '취소';
            job.progress.updatedAt = job.updatedAt;
            job.progress.recentMessages = [...(job.progress.recentMessages || []), '사용자 취소'].slice(-5);
            this.finish(job, 'canceled');
            return this.toPublic(job);
        }

        if (!this.current || this.current.id !== id) throw new TaskNotFoundError(id);
        const job = this.current;
        if (job.cancelRequested) return this.toPublic(job);

        job.cancelRequested = true;
        job.progress.message = '안전 종료 요청 중';
        job.progress.currentStep = '취소';
        job.updatedAt = this.clock().toISOString();
        job.progress.updatedAt = job.updatedAt;
        job.progress.recentMessages = [...(job.progress.recentMessages || []), '안전 종료 요청 중'].slice(-5);
        this.emit('cancel-requested', this.toPublic(job));
        this.emitChanged();
        if (typeof job.onCancel === 'function') {
            Promise.resolve().then(() => job.onCancel()).catch(error => {
                this.emit('cancel-error', { job: this.toPublic(job), error });
            });
        }
        return this.toPublic(job);
    }

    waitForCurrentCompletion(jobId, timeoutMs = 0) {
        if (!this.current || this.current.id !== jobId) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let timer = null;
            const cleanup = () => {
                this.off('changed', check);
                if (timer) clearTimeout(timer);
            };
            const check = snapshot => {
                if (!snapshot.current || snapshot.current.id !== jobId) {
                    cleanup();
                    resolve();
                }
            };
            this.on('changed', check);
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    cleanup();
                    reject(new Error('현재 작업이 제한 시간 내에 안전 종료되지 않았습니다.'));
                }, timeoutMs);
            }
            check(this.getSnapshot());
        });
    }

    async cancelAll({ timeoutMs = 0 } = {}) {
        if (this.stopPromise) return this.stopPromise;

        const waitingJobs = this.pending.splice(0);
        const currentId = this.current?.id || null;
        this.stopping = true;
        this.emit('stop-requested', { currentId, waitingCount: waitingJobs.length });
        this.emitChanged();

        for (const job of waitingJobs) {
            job.status = STATUS.CANCELED;
            job.endedAt = this.clock().toISOString();
            job.durationSeconds = 0;
            job.updatedAt = job.endedAt;
            job.progress = {
                current: 0, total: null, percent: 0, etaSeconds: null,
                message: '사용자 취소', currentStep: '취소', updatedAt: job.updatedAt,
                recentMessages: [...(job.progress.recentMessages || []), '사용자 취소'].slice(-5)
            };
            this.finish(job, 'canceled');
        }

        const operation = (async () => {
            if (currentId && this.current?.id === currentId) {
                await this.cancel(currentId);
                await this.waitForCurrentCompletion(currentId, timeoutMs);
            }
            return {
                currentCanceled: Boolean(currentId),
                waitingCanceled: waitingJobs.length
            };
        })();

        this.stopPromise = operation.then(result => {
            this.emit('stop-completed', result);
            return result;
        }).finally(() => {
            this.stopping = false;
            this.stopPromise = null;
            this.emitChanged();
            queueMicrotask(() => this.processNext());
        });
        return this.stopPromise;
    }

    async processNext() {
        if (this.stopping || this.processing || this.current || this.pending.length === 0) return;
        this.processing = true;
        const job = this.pending.shift();
        this.current = job;
        job.status = STATUS.RUNNING;
        job.startedAt = this.clock().toISOString();
        job.updatedAt = job.startedAt;
        job.progress.message = '실행 시작';
        job.progress.currentStep = '시작 준비';
        job.progress.updatedAt = job.startedAt;
        job.progress.recentMessages = [...(job.progress.recentMessages || []), '실행 시작'].slice(-5);
        this.emit('started', this.toPublic(job));
        this.emitChanged();

        const context = {
            id: job.id,
            reportProgress: progress => this.reportProgress(job.id, progress),
            isCancellationRequested: () => job.cancelRequested,
            throwIfCancellationRequested: () => {
                if (job.cancelRequested) {
                    const error = new Error('작업 취소 요청');
                    error.code = 'TASK_CANCELED';
                    throw error;
                }
            }
        };

        try {
            job.result = await job.run(context);
            if (job.cancelRequested) {
                job.status = STATUS.CANCELED;
                job.progress.message = '사용자 취소';
                job.progress.currentStep = '취소';
            } else {
                job.status = STATUS.COMPLETED;
                if (job.progress.total !== null && job.progress.total > 0) job.progress.current = job.progress.total;
                job.progress.percent = 100;
                job.progress.etaSeconds = 0;
                job.progress.message = '완료';
                job.progress.currentStep = '완료';
            }
        } catch (error) {
            if (job.cancelRequested || error?.code === 'TASK_CANCELED') {
                job.status = STATUS.CANCELED;
                job.progress.message = '사용자 취소';
                job.progress.currentStep = '취소';
            } else {
                job.status = STATUS.FAILED;
                job.error = String(error?.message || error).slice(0, 500);
                job.progress.message = job.error;
                job.progress.currentStep = '실패';
            }
        } finally {
            job.endedAt = this.clock().toISOString();
            job.updatedAt = job.endedAt;
            job.progress.updatedAt = job.endedAt;
            if (job.progress.message) {
                job.progress.recentMessages = [...(job.progress.recentMessages || []), job.progress.message]
                    .filter((message, index, values) => index === 0 || message !== values[index - 1])
                    .slice(-5);
            }
            job.durationSeconds = Math.max(0, Math.round((new Date(job.endedAt) - new Date(job.startedAt)) / 1000));
            const eventName = job.status === STATUS.COMPLETED ? 'completed' : job.status === STATUS.CANCELED ? 'canceled' : 'failed';
            this.current = null;
            this.processing = false;
            this.finish(job, eventName);
            queueMicrotask(() => this.processNext());
        }
    }

    finish(job, eventName) {
        this.recent.unshift(job);
        this.recent = this.recent.slice(0, this.recentLimit);
        this.emit(eventName, this.toPublic(job));
        this.emitChanged();
    }

    emitChanged() {
        this.emit('changed', this.getSnapshot());
    }

    toPublic(job) {
        return {
            id: job.id,
            type: job.type,
            label: job.label,
            title: job.label,
            registeredAt: job.registeredAt,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            updatedAt: job.updatedAt,
            status: job.status,
            statusCode: STATUS_CODE[job.status] || 'unknown',
            progress: { ...job.progress },
            progressPercent: job.progress.percent,
            current: job.progress.current,
            total: job.progress.total,
            message: job.progress.message,
            currentStep: job.progress.currentStep,
            estimatedRemainingMs: job.progress.etaSeconds === null ? null : job.progress.etaSeconds * 1000,
            durationSeconds: job.durationSeconds,
            error: job.error,
            metadata: { ...job.metadata }
        };
    }
}

module.exports = { TaskQueue, DuplicateTaskError, TaskNotFoundError, QueueStoppingError, STATUS };
