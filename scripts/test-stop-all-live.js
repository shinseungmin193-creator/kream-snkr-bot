const assert = require('assert');
const http = require('http');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const baseUrlArgument = process.argv.find(argument => argument.startsWith('--base='));
const baseUrl = (baseUrlArgument ? baseUrlArgument.slice('--base='.length) : 'http://127.0.0.1:3000').replace(/\/$/, '');

if (!process.argv.includes('--live')) {
    console.error('실제 KREAM BOT 중지 테스트는 --live 옵션이 필요합니다.');
    process.exit(2);
}

async function api(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: AbortSignal.timeout(120000)
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data.success === false) {
        throw new Error(data.message || `${path} 요청 실패 (${response.status})`);
    }
    return data;
}

async function waitUntil(test, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await test();
        if (result) return result;
        await delay(100);
    }
    throw new Error('실제 작업 중지 테스트 대기 시간 초과');
}

function connectSse() {
    const messages = [];
    let buffer = '';
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    const request = http.get(`${baseUrl}/logs`, response => {
        if (response.statusCode !== 200) {
            readyReject(new Error(`SSE 연결 실패 (${response.statusCode})`));
            return;
        }
        response.setEncoding('utf8');
        response.on('data', chunk => {
            buffer += chunk;
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            for (const block of blocks) {
                for (const line of block.split(/\r?\n/)) {
                    if (line.startsWith('data: ')) messages.push(line.slice(6).replace(/\\n/g, '\n'));
                }
            }
        });
        readyResolve();
    });
    request.on('error', readyReject);
    return { messages, ready, close: () => request.destroy() };
}

async function enqueue(path, method = 'POST') {
    return api(path, method === 'POST'
        ? { method, headers: { 'Content-Type': 'application/json' }, body: '{}' }
        : { method });
}

(async () => {
    const initial = await api('/api/queue');
    if (initial.queue.current || initial.queue.waiting.length) {
        throw new Error('다른 작업이 진행 중이므로 실제 중지 테스트를 시작하지 않습니다.');
    }

    const sse = connectSse();
    await sse.ready;
    const jobs = [];
    try {
        jobs.push((await enqueue('/api/inventory/sync')).job);
        await waitUntil(async () => (await api('/api/queue')).queue.current?.id === jobs[0].id);
        jobs.push((await enqueue('/api/inventory/compare')).job);
        jobs.push((await enqueue('/run/pokemon', 'GET')).job);
        jobs.push((await enqueue('/run/onepiece', 'GET')).job);

        const queued = await waitUntil(async () => {
            const snapshot = (await api('/api/queue')).queue;
            return snapshot.current?.id === jobs[0].id && snapshot.waiting.length === 3 ? snapshot : null;
        });
        assert.strictEqual(queued.waiting.length, 3);

        const stopped = await api('/api/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.deepStrictEqual(stopped.result, { currentCanceled: true, waitingCanceled: 3 });

        const after = (await api('/api/queue')).queue;
        assert.strictEqual(after.current, null, '현재 작업이 초기화되지 않음');
        assert.strictEqual(after.waiting.length, 0, '대기열이 비워지지 않음');
        assert.strictEqual(after.stopping, false, '중지 진행 상태가 초기화되지 않음');

        const recentById = new Map(after.recent.map(job => [job.id, job]));
        for (const job of jobs) assert.strictEqual(recentById.get(job.id)?.status, '취소', `${job.label}이 취소되지 않음`);
        for (const job of jobs.slice(1)) assert.strictEqual(recentById.get(job.id)?.startedAt, null, `${job.label}이 중지 후 실행됨`);

        const system = await api('/api/system/status');
        assert.strictEqual(system.job.busy, false, 'Playwright/child 작업이 종료되지 않음');

        const expectedLogs = ['작업 중지 요청', '현재 작업 취소', '대기열 3개 제거', '작업 중지 완료'];
        await waitUntil(() => expectedLogs.every(message => sse.messages.includes(message)), 5000);
        const positions = expectedLogs.map(message => sse.messages.indexOf(message));
        assert(positions.every((position, index) => index === 0 || position > positions[index - 1]), 'SSE 작업 중지 로그 순서가 올바르지 않음');
        for (const job of jobs.slice(1)) {
            assert(!sse.messages.some(message => message.startsWith(`Queue 시작: ${job.label}`)), `${job.label}이 실제로 시작됨`);
        }

        console.log('실제 작업 중지 테스트 통과');
        console.log(`- 현재 작업 안전 취소: ${jobs[0].label}`);
        console.log('- 대기열 제거: 3개');
        console.log('- Playwright/child busy: false');
        console.log(`- SSE 로그: ${expectedLogs.join(' → ')}`);
    } catch (error) {
        try { await api('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
        throw error;
    } finally {
        sse.close();
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
