const assert = require('assert');
const { TaskQueue, DuplicateTaskError, QueueStoppingError, STATUS } = require('../system/task-queue');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(test, timeout = 3000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (test()) return;
        await delay(5);
    }
    throw new Error('Queue 테스트 대기 시간 초과');
}

async function testSequentialExecution() {
    const queue = new TaskQueue();
    const timeline = [];
    let running = 0;
    let maximumRunning = 0;
    const makeTask = (type, label, ms) => queue.enqueue({
        type,
        label,
        requestIp: '127.0.0.1',
        run: async context => {
            running++;
            maximumRunning = Math.max(maximumRunning, running);
            timeline.push(`start:${type}`);
            context.reportProgress({ current: 1, total: 2, message: '진행 중' });
            await delay(ms);
            timeline.push(`end:${type}`);
            running--;
        }
    });

    makeTask('inventory-sync', '판매목록 동기화', 30);
    makeTask('price-compare-selected', '선택 가격 비교', 20);
    makeTask('price-update', '가격 수정', 10);
    await waitUntil(() => queue.getSnapshot().recent.length === 3);

    assert.strictEqual(maximumRunning, 1, '동시에 둘 이상의 작업이 실행됨');
    assert.deepStrictEqual(timeline, [
        'start:inventory-sync', 'end:inventory-sync',
        'start:price-compare-selected', 'end:price-compare-selected',
        'start:price-update', 'end:price-update'
    ]);
    assert(queue.getSnapshot().recent.every(job => job.status === STATUS.COMPLETED));
}

async function testDuplicateProtection() {
    const queue = new TaskQueue();
    let release;
    const blocker = new Promise(resolve => { release = resolve; });
    queue.enqueue({ type:'inventory-sync', label:'판매목록 동기화', requestIp:'127.0.0.1', run:() => blocker });
    assert.throws(() => queue.enqueue({
        type:'inventory-sync', label:'판매목록 동기화', requestIp:'127.0.0.2', run:async () => {}
    }), error => error instanceof DuplicateTaskError && error.message === '이미 실행중입니다.');
    release();
    await waitUntil(() => queue.getSnapshot().recent.length === 1);
}

async function testWaitingAndRunningCancellation() {
    const queue = new TaskQueue();
    let cancelHookCalled = false;
    queue.enqueue({
        type:'inventory-sync',
        label:'판매목록 동기화',
        requestIp:'127.0.0.1',
        onCancel:() => { cancelHookCalled = true; },
        run:async context => {
            while (!context.isCancellationRequested()) await delay(5);
            context.throwIfCancellationRequested();
        }
    });
    const waiting = queue.enqueue({ type:'price-update', label:'가격 수정', requestIp:'127.0.0.2', run:async () => {} });
    await waitUntil(() => queue.getSnapshot().current?.type === 'inventory-sync');
    const canceledWaiting = await queue.cancel(waiting.id);
    assert.strictEqual(canceledWaiting.status, STATUS.CANCELED);
    const runningId = queue.getSnapshot().current.id;
    await queue.cancel(runningId);
    await waitUntil(() => queue.getSnapshot().current === null);
    assert.strictEqual(cancelHookCalled, true);
    assert.strictEqual(queue.getSnapshot().recent.filter(job => job.status === STATUS.CANCELED).length, 2);
}

async function testRecentLimit() {
    const queue = new TaskQueue({ recentLimit:50 });
    for (let index = 0; index < 55; index++) {
        queue.enqueue({ type:`test-${index}`, label:`테스트 ${index}`, requestIp:'127.0.0.1', run:async () => {} });
    }
    await waitUntil(() => queue.getSnapshot().current === null && queue.getSnapshot().waiting.length === 0);
    assert.strictEqual(queue.getSnapshot().recent.length, 50);
}

async function testStopAll() {
    const queue = new TaskQueue();
    const stopEvents = [];
    let cancelHookCalled = false;
    let waitingExecuted = 0;

    queue.on('stop-requested', event => stopEvents.push(`requested:${event.waitingCount}`));
    queue.on('stop-completed', event => stopEvents.push(`completed:${event.waitingCanceled}`));
    queue.enqueue({
        type:'inventory-sync',
        label:'판매목록 동기화',
        requestIp:'127.0.0.1',
        onCancel:() => { cancelHookCalled = true; },
        run:async context => {
            while (!context.isCancellationRequested()) await delay(5);
            await delay(25);
            context.throwIfCancellationRequested();
        }
    });
    for (const [type, label] of [
        ['price-compare-all', '전체 가격 비교'],
        ['price-compare-selected', '선택 가격 비교'],
        ['price-update', '가격 수정']
    ]) {
        queue.enqueue({ type, label, requestIp:'127.0.0.2', run:async () => { waitingExecuted++; } });
    }
    await waitUntil(() => queue.getSnapshot().current?.type === 'inventory-sync');

    const stopPromise = queue.cancelAll({ timeoutMs:1000 });
    assert.strictEqual(queue.getSnapshot().waiting.length, 0, '중지 즉시 대기열이 비워지지 않음');
    assert.strictEqual(queue.getSnapshot().stopping, true, '중지 처리 상태가 표시되지 않음');
    assert.throws(() => queue.enqueue({
        type:'legacy-pokemon', label:'포켓몬 실행', requestIp:'127.0.0.3', run:async () => {}
    }), error => error instanceof QueueStoppingError);

    const result = await stopPromise;
    const snapshot = queue.getSnapshot();
    assert.deepStrictEqual(result, { currentCanceled:true, waitingCanceled:3 });
    assert.strictEqual(cancelHookCalled, true, 'Playwright 안전 종료 훅이 호출되지 않음');
    assert.strictEqual(waitingExecuted, 0, '중지 후 대기 작업이 실행됨');
    assert.strictEqual(snapshot.current, null, '중지 완료 후 현재 작업이 남아 있음');
    assert.strictEqual(snapshot.waiting.length, 0, '중지 완료 후 대기열이 남아 있음');
    assert.strictEqual(snapshot.stopping, false, '중지 완료 후 상태가 초기화되지 않음');
    assert.strictEqual(snapshot.recent.filter(job => job.status === STATUS.CANCELED).length, 4);
    assert.deepStrictEqual(stopEvents, ['requested:3', 'completed:3']);
}

(async () => {
    await testSequentialExecution();
    await testDuplicateProtection();
    await testWaitingAndRunningCancellation();
    await testStopAll();
    await testRecentLimit();
    console.log('작업 Queue 테스트 통과: 동시 실행 1, 순서 보장, 중복 차단, 전체 중지, Playwright 취소 훅, 최근 50개');
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
