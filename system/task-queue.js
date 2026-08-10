const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const STATUS = Object.freeze({
    WAITING: '대기중',
    RUNNING: '실행중',
    COMPLETED: '완료',
    FAILED: '실패',
    CANCELED: '취소'
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

        const job = {
            id: this.idFactory(),
            type: String(type),
            label: String(label || type),
            requestIp: String(requestIp || 'unknown').slice(0, 80),
            registeredAt: this.clock().toISOString(),
            startedAt: null,
            endedAt: null,
            status: STATUS.WAITING,
            progress: { current: 0, total: 0, percent: 0, etaSeconds: null, message: '대기 중' },
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
        const current = Math.max(0, Number(progress.current ?? job.progress.current) || 0);
        const total = Math.max(0, Number(progress.total ?? job.progress.total) || 0);
        const calculated = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
        const percent = Math.max(0, Math.min(100, Number(progress.percent ?? calculated) || 0));
        let etaSeconds = null;

        if (job.startedAt && total > 0 && current > 0 && current < total) {
            const elapsed = Math.max(0, (this.clock().getTime() - new Date(job.startedAt).getTime()) / 1000);
            etaSeconds = Math.max(0, Math.round((elapsed / current) * (total - current)));
        } else if (current >= total && total > 0) {
            etaSeconds = 0;
        }

        job.progress = {
            current,
            total,
            percent,
            etaSeconds,
            message: String(progress.message ?? job.progress.message ?? '').slice(0, 200)
        };
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
            job.durationSeconds = 0;
            job.progress.message = '대기 중 취소됨';
            this.finish(job, 'canceled');
            return this.toPublic(job);
        }

        if (!this.current || this.current.id !== id) throw new TaskNotFoundError(id);
        const job = this.current;
        if (job.cancelRequested) return this.toPublic(job);

        job.cancelRequested = true;
        job.progress.message = '안전 종료 요청 중';
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
            job.progress = { current: 0, total: 0, percent: 0, etaSeconds: null, message: '전체 작업 중지로 취소됨' };
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
        job.progress.message = '실행 시작';
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
                job.progress.message = '취소됨';
            } else {
                job.status = STATUS.COMPLETED;
                job.progress.percent = 100;
                job.progress.etaSeconds = 0;
                job.progress.message = '완료';
            }
        } catch (error) {
            if (job.cancelRequested || error?.code === 'TASK_CANCELED') {
                job.status = STATUS.CANCELED;
                job.progress.message = '취소됨';
            } else {
                job.status = STATUS.FAILED;
                job.error = String(error?.message || error).slice(0, 500);
                job.progress.message = '실패';
            }
        } finally {
            job.endedAt = this.clock().toISOString();
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
            registeredAt: job.registeredAt,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            status: job.status,
            progress: { ...job.progress },
            durationSeconds: job.durationSeconds,
            error: job.error,
            metadata: { ...job.metadata }
        };
    }
}

module.exports = { TaskQueue, DuplicateTaskError, TaskNotFoundError, QueueStoppingError, STATUS };
