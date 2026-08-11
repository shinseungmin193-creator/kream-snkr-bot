const express = require('express');
const path = require('path');
const fs = require('fs');
const inventoryDb = require('./database');
const { spawn, execFile } = require('child_process');
const { chromium } = require('playwright');
const fileLogger = require('./system/file-logger');
const { TaskQueue, DuplicateTaskError, TaskNotFoundError, QueueStoppingError, STATUS: QUEUE_STATUS } = require('./system/task-queue');
const {
    SystemManager,
    readSettings,
    readUpdateHistory,
    maskText,
    config: systemConfig
} = require('./system/system-manager');

const app = express();
const taskQueue = new TaskQueue({ recentLimit: 50 });

app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    maxAge: 0,
    setHeaders(res) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
}));

let clients = [];

let stopRequested = false;
let currentChild = null;
let currentPage = null;
let currentBrowser = null;
let currentJobName = null;
let stopAllPromise = null;

const systemManager = new SystemManager({
    inventoryDb,
    chromium,
    getJobState: () => ({
        busy: Boolean(taskQueue.current || taskQueue.pending.length || currentChild || currentPage),
        name: taskQueue.current?.label || taskQueue.pending[0]?.label || currentJobName || (currentPage ? 'KREAM 재고 수정' : null),
        childPid: currentChild?.pid || null
    })
});

const STOP_MESSAGE = '전체 작업 중지';

function isStopError(err) {
    const msg = String(err && err.message ? err.message : err || '');

    return (
        stopRequested ||
        msg.includes(STOP_MESSAGE) ||
        msg.includes('중지') ||
        msg.includes('stop')
    );
}

function sendSse(text) {
    const msg = String(text);

    clients.forEach(client => {
        client.write(`data: ${msg.replace(/\r?\n/g, '\\n')}\n\n`);
    });
}

function sendLog(text) {
    const msg = String(text);

    process.stdout.write(msg.endsWith('\n') ? msg : msg + '\n');
    fileLogger.write('app', msg);
    if (/^\[ERROR\]|실패|오류/.test(msg)) fileLogger.write('error', msg);
    sendSse(msg);
}

function sendSpecial(text) {
    sendSse(text);
}

function sendQueueState(snapshot = taskQueue.getSnapshot()) {
    const base64 = Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64');
    sendSpecial(`__QUEUE_STATE_B64__:${base64}`);
}

function requestIpFrom(req) {
    return String(req.ip || req.socket?.remoteAddress || 'unknown').trim().slice(0, 80);
}

function enqueueAutomation(req, res, options) {
    try {
        const job = taskQueue.enqueue({
            type: options.type,
            label: options.label,
            requestIp: requestIpFrom(req),
            metadata: options.metadata || {},
            run: options.run,
            onCancel: requestStop
        });
        return res.status(202).json({ success: true, queued: true, job });
    } catch (error) {
        if (error instanceof DuplicateTaskError || error instanceof QueueStoppingError) {
            return res.status(409).json({ success: false, code: error.code, message: error.message });
        }
        throw error;
    }
}

function resetStop() {
    stopRequested = false;
}

function requestStop() {
    if (stopRequested) {
        sendSpecial('__STOP_REQUESTED__');
        return;
    }

    stopRequested = true;

    sendSpecial('__STOP_REQUESTED__');

    if (currentChild && currentChild.pid) {
        const childToStop = currentChild;
        const childPid = childToStop.pid;
        try {
            const killSent = childToStop.kill();
            sendLog(`실행중인 node 작업 직접 종료 요청: pid=${childPid}, sent=${killSent}`);
            if (process.platform === 'win32') {
                execFile('taskkill.exe', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true }, error => {
                    if (error && !childToStop.killed) sendLog(`child 프로세스 트리 종료 실패: pid=${childPid}, ${error.message}`);
                });
            }
        } catch (err) {
            sendLog('child 종료 실패: ' + err.message);
        }
    }

    if (currentPage) {
        const pageToClose = currentPage;
        currentPage = null;

        pageToClose.close().catch(() => {});
        sendLog('현재 Playwright 페이지 종료 요청');
    }
}

taskQueue.on('registered', job => sendLog(`Queue 등록: ${job.label}`));
taskQueue.on('started', job => sendLog(`Queue 시작: ${job.label} (${job.id})`));
taskQueue.on('completed', job => {
    sendLog(`Queue 완료: ${job.label} (${job.durationSeconds}초)`);
    if (['price-compare-all', 'price-compare-selected', 'price-update'].includes(job.type) || String(job.type || '').startsWith('legacy-')) {
        sendLog('UI 수정 대상 갱신 요청');
        sendSpecial('__TARGETS_REFRESH__');
    }
});
taskQueue.on('failed', job => sendLog(`Queue 실패: ${job.label} - ${job.error || '알 수 없는 오류'}`));
taskQueue.on('canceled', job => sendLog(`Queue 취소: ${job.label}`));
taskQueue.on('cancel-requested', job => sendLog(`Queue 안전 종료 요청: ${job.label}`));
taskQueue.on('changed', snapshot => sendQueueState(snapshot));

function checkStop() {
    if (stopRequested) {
        throw new Error(STOP_MESSAGE);
    }
}

async function waitWithStop(page, ms) {
    const step = 300;
    let elapsed = 0;

    while (elapsed < ms) {
        checkStop();

        const waitTime = Math.min(step, ms - elapsed);

        if (page) {
            await page.waitForTimeout(waitTime);
        } else {
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        elapsed += waitTime;
    }
}

function getTypeByKeyword(keyword) {
    const k = String(keyword || '').toLowerCase();

    if (k.includes('포켓몬') || k.includes('pokemon')) return 'pokemon';
    if (k.includes('원피스') || k.includes('onepiece') || k.includes('one piece')) return 'onepiece';

    return 'all';
}

function getTargetFile(type) {
    if (type === 'pokemon') return 'update_targets_pokemon.json';
    if (type === 'onepiece') return 'update_targets_onepiece.json';

    return 'update_targets.json';
}

function getInventoryFile(type) {
    if (type === 'pokemon') return 'inventory_pokemon.json';
    if (type === 'onepiece') return 'inventory_onepiece.json';
    return 'inventory_all.json';
}

function getComparisonResultFile(type) {
    if (type === 'pokemon') return 'inventory_result_pokemon.json';
    if (type === 'onepiece') return 'inventory_result_onepiece.json';
    return 'inventory_result.json';
}

function readJsonFile(fileName) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, fileName), 'utf8'));
}

function ensureComparisonCoverage(results, expectedStockIds, label) {
    const expected = [...new Set((expectedStockIds || []).map(value => String(value || '').trim()).filter(Boolean))];
    const actual = (results || []).map(item => String(item?.stockId || '').trim()).filter(Boolean);
    const actualSet = new Set(actual);
    if (actualSet.size !== actual.length) throw new Error(`${label} 결과에 중복 stockId가 있습니다.`);
    const missing = expected.filter(stockId => !actualSet.has(stockId));
    const unexpected = actual.filter(stockId => !expected.includes(stockId));
    if (missing.length || unexpected.length || actual.length !== expected.length) {
        throw new Error(`${label} 결과 불일치: 요청 ${expected.length}개, 처리 ${actual.length}개, 누락 ${missing.length}개, 초과 ${unexpected.length}개`);
    }
}

function canonicalTargetsForType(type) {
    const items = inventoryDb.targets();
    if (type === 'pokemon') return items.filter(item => /포켓몬|pokemon/i.test(item.productName || ''));
    if (type === 'onepiece') return items.filter(item => /원피스|one\s*piece/i.test(item.productName || ''));
    return items;
}

function toLegacyTarget(item) {
    return {
        ...item,
        koreanName: item.productName,
        option: item.optionName,
        myPrice: item.currentPrice
    };
}

function parsePrice(value) {
    const n = Number(String(value || '').replace(/[^\d]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

function formatPrice(value) {
    return Number(value || 0).toLocaleString('ko-KR');
}

function handleScriptLine(line, logType = null) {
    const text = String(line || '').trimEnd();

    if (!text) {
        sendLog('');
        return;
    }

    if (text.startsWith('__TARGET_FOUND__:')) {
        const jsonText = text.replace('__TARGET_FOUND__:', '');
        const base64 = Buffer.from(jsonText, 'utf8').toString('base64');

        sendSpecial(`__TARGET_FOUND_B64__:${base64}`);
        return;
    }

    if (text.startsWith('__AUTOMATION_PROGRESS__:')) return;

    if (logType) fileLogger.write(logType, text);
    sendLog(text);
}

function sendStoppedResponse(res) {
    res.json({
        success: false,
        stopped: true,
        message: STOP_MESSAGE
    });
}

app.get('/logs', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    res.write(`data: 로그 연결됨\n\n`);

    clients.push(res);
    const queueState = Buffer.from(JSON.stringify(taskQueue.getSnapshot()), 'utf8').toString('base64');
    res.write(`data: __QUEUE_STATE_B64__:${queueState}\n\n`);

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

function runScript(scriptName, args = [], onLine = null) {
    return new Promise((resolve, reject) => {
        checkStop();

        const scriptPath = path.resolve(__dirname, scriptName);
        sendLog(`===== ${scriptName} 시작 =====`);
        sendLog(`실행 파일: ${scriptPath}`);
        sendLog(`실행 인자: ${JSON.stringify(args)}`);

        const logType = scriptName === 'inventory.js' ? 'inventory' : scriptName === 'compareAll.js' ? 'compare' : null;
        currentJobName = scriptName;
        currentChild = spawn(process.execPath, [scriptPath, ...args], {
            cwd: __dirname,
            // Keep empty/explicit arguments intact on Windows. A shell may drop ''.
            shell: false
        });

        let stdoutBuffer = '';
        let stderrBuffer = '';
        let finishedByStop = false;

        currentChild.stdout.on('data', data => {
            stdoutBuffer += data.toString();

            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop();

            lines.forEach(line => {
                handleScriptLine(line, logType);
                if (typeof onLine === 'function') onLine(line);
            });
        });

        currentChild.stderr.on('data', data => {
            stderrBuffer += data.toString();

            const lines = stderrBuffer.split(/\r?\n/);
            stderrBuffer = lines.pop();

            lines.forEach(line => {
                sendLog('[ERROR] ' + line);
                if (logType) fileLogger.write(logType, `[ERROR] ${line}`);
            });
        });

        currentChild.on('close', code => {
            if (stdoutBuffer.trim()) {
                handleScriptLine(stdoutBuffer, logType);
                if (typeof onLine === 'function') onLine(stdoutBuffer);
            }

            if (stderrBuffer.trim()) {
                sendLog('[ERROR] ' + stderrBuffer);
            }

            if (stopRequested) {
                finishedByStop = true;
                sendLog(`===== ${scriptName} 중지됨 =====`);
                currentChild = null;
                currentJobName = null;
                reject(new Error(STOP_MESSAGE));
                return;
            }

            sendLog(`===== ${scriptName} 종료 (${code}) =====`);

            currentChild = null;
            currentJobName = null;

            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${scriptName} 실패 (종료코드 ${code})`));
            }
        });

        currentChild.on('error', err => {
            currentChild = null;
            currentJobName = null;

            if (finishedByStop || stopRequested) {
                reject(new Error(STOP_MESSAGE));
                return;
            }

            reject(err);
        });
    });
}

async function runKreamFlow(keyword, context, range = { start: 0, end: 100 }) {
    const type = getTypeByKeyword(keyword);

    checkStop();

    sendLog(`${keyword} 실행 시작`);
    sendSpecial(`__RUN_START__:${type}`);
    reportProgressInRange(context, {
        current: 0, total: null, percent: 0,
        step: '대상 계산', message: `${keyword} 판매 재고 검색 준비 중`
    }, range, `legacy-${type}-inventory`);

    // Legacy flows keep their explicit keyword; inventory sync uses --sync-all separately.
    await runScript('inventory.js', ['--keyword', keyword], inventoryProgressReporter(
        context,
        subProgressRange(range, 0, 0.2)
    ));
    checkStop();

    const inventoryItems = readJsonFile(getInventoryFile(type));
    const inventoryCounts = inventoryDb.upsertInventory(inventoryItems, false);
    sendLog(`${keyword} 판매 재고 DB 동기화: ${inventoryCounts.success}개`);
    reportProgressInRange(context, {
        current: 0, total: inventoryItems.length, percent: 20,
        step: '최저가 조회 준비', message: `${keyword} 가격 비교 대상 ${inventoryItems.length}개 확인`
    }, range, `legacy-${type}-compare`);

    await runScript('compareAll.js', [keyword], compareProgressReporter(
        context,
        inventoryItems.length,
        subProgressRange(range, 0.2, 0.95)
    ));
    checkStop();

    reportProgressInRange(context, {
        current: inventoryItems.length, total: inventoryItems.length, percent: 96,
        step: '수정 대상 계산', message: `${keyword} 수정 대상 필터링 중`
    }, range, `legacy-${type}-finalize`);
    await runScript('filterTargets.js', [keyword]);
    checkStop();

    const results = readJsonFile(getComparisonResultFile(type));
    const calculatedTargets = readJsonFile(getTargetFile(type));
    ensureComparisonCoverage(results, inventoryItems.map(item => item.stockId), `${keyword} 가격 비교`);
    const counts = inventoryDb.applyComparison(results);
    const snapshot = inventoryDb.targetSnapshot();
    const processedIds = new Set(results.map(item => String(item.stockId)));
    const storedScopeCount = snapshot.items.filter(item => processedIds.has(String(item.stockId))).length;
    sendLog(`수정 대상 계산: ${calculatedTargets.length}개`);
    sendLog(`DB 수정 대상 저장 완료: ${storedScopeCount}개`);
    sendLog(`${keyword} 비교 결과 DB 반영: ${results.length}개 / 하한가 도달 ${counts.floors}개 / 실패 ${counts.failures}개`);
    sendLog(`전체 수정 대상 현재: ${snapshot.count}개`);
    reportProgressInRange(context, {
        current: results.length, total: results.length, percent: 100,
        step: 'DB 저장', message: `${keyword} 수정 대상 ${storedScopeCount}개 DB 반영 완료`
    }, range, `legacy-${type}-finalize`);

    sendLog(`${keyword} 작업 완료`);
    sendSpecial(`__RUN_DONE__:${type}`);
    sendSpecial(`__REFRESH_TARGETS__:${type}`);
    return { total: results.length, targets: storedScopeCount, ...counts };
}

async function clickRealRowEditButton(page, row, stockId) {
    checkStop();

    const span = row.getByText('재고 수정', { exact: true }).last();

    if (!(await span.count())) {
        throw new Error(`행 안에서 재고 수정 텍스트를 찾지 못함: ${stockId}`);
    }

    await span.scrollIntoViewIfNeeded({ timeout: 5000 });

    checkStop();

    const button = span.locator('xpath=ancestor::button[1]');

    if (!(await button.count())) {
        throw new Error(`재고 수정 텍스트의 부모 button을 찾지 못함: ${stockId}`);
    }

    await button.click({
        timeout: 10000,
        force: true
    });
}

async function clickCheckboxNearPriceInput(page, priceInput, stockId) {
    checkStop();

    const editRow = priceInput.locator('xpath=ancestor::div[.//input[@type="checkbox"]][1]');

    await editRow.waitFor({
        state: 'attached',
        timeout: 15000
    });

    checkStop();

    const checkboxInput = editRow.locator('input[type="checkbox"]').first();

    await checkboxInput.waitFor({
        state: 'attached',
        timeout: 15000
    });

    checkStop();

    const beforeChecked = await checkboxInput.isChecked().catch(() => false);

    if (beforeChecked) {
        sendLog(`체크박스 이미 선택됨: stockId=${stockId}`);
        return;
    }

    const visibleBox = editRow.locator('div[class*="Size_width-24"][class*="Size_height-24"]').first();

    if (await visibleBox.count()) {
        await visibleBox.scrollIntoViewIfNeeded({ timeout: 5000 });

        checkStop();

        await visibleBox.click({
            timeout: 10000,
            force: true
        });

        await waitWithStop(page, 500);

        const checkedAfterBoxClick = await checkboxInput.isChecked().catch(() => false);

        if (checkedAfterBoxClick) {
            sendLog(`체크박스 박스 클릭 선택 완료: stockId=${stockId}`);
            return;
        }
    }

    checkStop();

    await checkboxInput.focus();
    await page.keyboard.press('Space');

    await waitWithStop(page, 500);

    const checkedAfterSpace = await checkboxInput.isChecked().catch(() => false);

    if (checkedAfterSpace) {
        sendLog(`체크박스 Space 선택 완료: stockId=${stockId}`);
        return;
    }

    const inputBox = await checkboxInput.boundingBox();

    if (inputBox) {
        checkStop();

        await page.mouse.click(
            inputBox.x + inputBox.width / 2,
            inputBox.y + inputBox.height / 2
        );

        await waitWithStop(page, 500);

        const checkedAfterInputClick = await checkboxInput.isChecked().catch(() => false);

        if (checkedAfterInputClick) {
            sendLog(`체크박스 input 좌표 클릭 선택 완료: stockId=${stockId}`);
            return;
        }
    }

    checkStop();

    const clickedByDom = await page.evaluate(() => {
        const priceInput = document.querySelector('input[name^="items."][name$=".price"]');

        if (!priceInput) return false;

        let parent = priceInput.parentElement;

        for (let i = 0; i < 15 && parent; i++) {
            const checkbox = parent.querySelector('input[type="checkbox"]');

            if (checkbox) {
                checkbox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                checkbox.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                checkbox.checked = true;
                checkbox.dispatchEvent(new Event('input', { bubbles: true }));
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }

            parent = parent.parentElement;
        }

        return false;
    });

    if (clickedByDom) {
        await waitWithStop(page, 500);

        const checkedAfterDom = await checkboxInput.isChecked().catch(() => false);

        if (checkedAfterDom) {
            sendLog(`체크박스 DOM 이벤트 선택 완료: stockId=${stockId}`);
            return;
        }
    }

    throw new Error(`체크박스 선택 실패: stockId=${stockId}`);
}

async function clickConfirmButton(page, stockId) {
    checkStop();

    const confirmButton = page.getByRole('button', { name: '확인' }).last();

    await confirmButton.waitFor({
        state: 'visible',
        timeout: 15000
    });

    checkStop();

    await confirmButton.click({
        timeout: 10000,
        force: true
    });

    sendLog(`확인 버튼 클릭 완료: stockId=${stockId}`);
    await confirmButton.waitFor({ state: 'hidden', timeout: 15000 });
}

async function safeFillPrice(page, priceInput, newPrice, stockId) {
    checkStop();

    const priceText = String(Number(newPrice));

    await priceInput.click({ timeout: 5000 });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await priceInput.fill('');
    await priceInput.type(priceText, { delay: 30 });
    await waitWithStop(page, 100);

    const inputValue = await priceInput.inputValue().catch(() => '');
    const inputNumber = parsePrice(inputValue);

    sendLog(`판매 희망가 입력 확인: 입력값=${inputValue}, 숫자=${formatPrice(inputNumber)}, 목표=${formatPrice(newPrice)}`);

    if (inputNumber !== Number(newPrice)) {
        throw new Error(`가격 입력값 불일치: stockId=${stockId}, 목표=${formatPrice(newPrice)}, 실제=${formatPrice(inputNumber)}`);
    }
}

async function applyStockEdit(page, stockId, newPrice) {
    checkStop();

    if (!newPrice || newPrice <= 0) {
        throw new Error(`입력할 새 가격 없음: stockId=${stockId}`);
    }

    sendLog(`가격 수정 시작: stockId=${stockId}, newPrice=${formatPrice(newPrice)}`);

    const priceInput = page.locator('input[name^="items."][name$=".price"]').first();

    await priceInput.waitFor({
        state: 'visible',
        timeout: 15000
    });

    checkStop();

    await clickCheckboxNearPriceInput(page, priceInput, stockId);

    checkStop();

    await safeFillPrice(page, priceInput, newPrice, stockId);

    sendLog(`판매 희망가 입력 완료: ${formatPrice(newPrice)}`);

    const submitButton = page.locator('button:has-text("재고 입력")').last();

    await submitButton.waitFor({
        state: 'visible',
        timeout: 15000
    });

    const maxWait = Date.now() + 15000;

    while (Date.now() < maxWait) {
        checkStop();

        const disabled = await submitButton.evaluate(button => button.disabled).catch(() => true);

        if (!disabled) break;

        await waitWithStop(page, 500);
    }

    const isDisabled = await submitButton.evaluate(button => button.disabled).catch(() => true);

    if (isDisabled) {
        throw new Error('재고 입력 버튼이 활성화되지 않음');
    }

    checkStop();

    await submitButton.click({
        timeout: 10000,
        force: true
    });

    sendLog(`재고 입력 버튼 클릭 완료: stockId=${stockId}`);

    await clickConfirmButton(page, stockId);

    sendLog(`가격 수정 최종 완료: stockId=${stockId}`);
}

async function openKreamStockEdit(stockId, newPrice, existingContext = null) {
    checkStop();

    if (!stockId) {
        throw new Error('stockId 없음');
    }

    const targetPrice = parsePrice(newPrice);

    if (!targetPrice || targetPrice <= 0) {
        throw new Error(`입력할 새 가격 없음: stockId=${stockId}`);
    }

    sendLog(`재고 수정 페이지 열기 시작: stockId=${stockId}`);
    sendLog(`웹 표 기준 입력 가격: ${formatPrice(targetPrice)}`);

    const connectionStartedAt = Date.now();
    if (!existingContext) currentBrowser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const context = existingContext || currentBrowser.contexts()[0];

    if (!context) {
        throw new Error('연결된 크롬 컨텍스트 없음. 크롬 원격 디버깅을 먼저 켜야 함.');
    }

    currentPage = await context.newPage();

    try {
        const itemStartedAt = Date.now();
        checkStop();

        const navigationStartedAt = Date.now();
        await currentPage.goto('https://partner.kream.co.kr/business/ask-sales', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        const navigationMs = Date.now() - navigationStartedAt;

        const searchInputCandidates = [
            'input[placeholder*="검색"]',
            'input[placeholder*="상품"]',
            'input[placeholder*="상품명"]',
            'input[type="search"]',
            'input'
        ];

        let searched = false;

        for (const selector of searchInputCandidates) {
            checkStop();

            const input = currentPage.locator(selector).first();

            if (await input.count()) {
                try {
                    await input.click({ timeout: 3000 });
                    await input.fill(String(stockId), { timeout: 3000 });
                    await input.press('Enter', { timeout: 3000 });
                    searched = true;
                    break;
                } catch (err) {
                }
            }
        }

        if (searched) {
            sendLog(`stockId 검색 시도 완료: ${stockId}`);
        } else {
            sendLog('검색창을 못 찾아서 현재 목록에서 stockId 직접 탐색');
        }

        checkStop();

        const stockText = currentPage.getByText(String(stockId), { exact: true }).first();

        const searchStartedAt = Date.now();
        await stockText.waitFor({
            state: 'visible',
            timeout: 15000
        });
        const searchMs = Date.now() - searchStartedAt;

        sendLog(`stockId 화면 확인 완료: ${stockId}`);

        checkStop();

        const row = stockText.locator('xpath=ancestor::div[contains(@class, "Table_row__")][1]');

        if (!(await row.count())) {
            throw new Error(`stockId 행을 찾지 못함: ${stockId}`);
        }

        sendLog(`stockId 행 찾기 완료: ${stockId}`);

        checkStop();

        const editOpenStartedAt = Date.now();
        await clickRealRowEditButton(currentPage, row, stockId);

        sendLog(`해당 행 재고 수정 버튼 클릭 완료: ${stockId}`);

        checkStop();

        const applyStartedAt = Date.now();
        await applyStockEdit(currentPage, stockId, targetPrice);
        const applyMs = Date.now() - applyStartedAt;
        sendLog(`[가격수정 계측] stockId=${stockId} CDP=${((Date.now() - connectionStartedAt - (Date.now() - itemStartedAt)) / 1000).toFixed(2)}초 페이지진입=${(navigationMs / 1000).toFixed(2)}초 검색=${(searchMs / 1000).toFixed(2)}초 수정화면=${((applyStartedAt - editOpenStartedAt) / 1000).toFixed(2)}초 입력·저장확인=${(applyMs / 1000).toFixed(2)}초 총=${((Date.now() - itemStartedAt) / 1000).toFixed(2)}초`);

    } finally {
        if (currentPage) {
            await currentPage.close().catch(() => {});
            currentPage = null;
        }
    }
}

function parseAutomationProgress(line) {
    const text = String(line || '');
    if (!text.startsWith('__AUTOMATION_PROGRESS__:')) return null;
    try { return JSON.parse(text.slice('__AUTOMATION_PROGRESS__:'.length)); }
    catch { return null; }
}

function reportProgressInRange(context, progress, range = { start: 0, end: 100 }, etaKey = null) {
    const start = Math.max(0, Math.min(100, Number(range.start) || 0));
    const end = Math.max(start, Math.min(100, Number(range.end) || 100));
    const current = Math.max(0, Number(progress.current) || 0);
    const total = progress.total === null || progress.total === undefined ? null : Math.max(0, Number(progress.total) || 0);
    const localPercent = progress.percent !== null && progress.percent !== undefined
        ? Math.max(0, Math.min(100, Number(progress.percent) || 0))
        : total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
    const roundedPercent = Math.round(start + ((end - start) * localPercent / 100));
    const percent = current > 0 && total > current
        ? Math.max(1, roundedPercent)
        : roundedPercent;
    context.reportProgress({
        current,
        total,
        percent,
        message: progress.message,
        step: progress.step,
        etaKey: progress.etaKey || etaKey || progress.step
    });
}

function subProgressRange(range, fromRatio, toRatio) {
    const start = Number(range.start) || 0;
    const end = Number(range.end) || 100;
    const width = end - start;
    return {
        start: start + width * fromRatio,
        end: start + width * toRatio
    };
}

function inventoryProgressReporter(context, range = { start: 0, end: 95 }) {
    let current = 0;
    let total = null;
    let structuredSeen = false;
    return line => {
        const text = String(line || '');
        const structured = parseAutomationProgress(text);
        if (structured) {
            structuredSeen = true;
            reportProgressInRange(context, structured, range, 'inventory');
            current = Math.max(current, Number(structured.current) || 0);
            if (structured.total !== null && structured.total !== undefined) total = Number(structured.total) || null;
            return;
        }
        if (structuredSeen) return;
        const totalMatch = text.match(/판매중 재고\s*(\d+)개/);
        const cumulativeMatch = text.match(/누적:\s*(\d+)개/);
        const savedMatch = text.match(/총\s*(\d+)개 저장 완료/);
        const pageMatch = text.match(/(\d+)\/(\d+)\s*페이지 수집 완료/);
        if (totalMatch) total = Number(totalMatch[1]);
        if (cumulativeMatch) current = Number(cumulativeMatch[1]);
        if (savedMatch) {
            current = Number(savedMatch[1]);
            total = total || current;
        }
        if (total > 0 && (totalMatch || cumulativeMatch || savedMatch)) {
            reportProgressInRange(context, { current, total, message: `판매목록 ${current} / ${total}`, step: '판매 재고 수집' }, range, 'inventory');
        } else if (pageMatch) {
            reportProgressInRange(context, {
                current: Number(pageMatch[1]),
                total: Number(pageMatch[2]),
                message: `${pageMatch[1]} / ${pageMatch[2]} 페이지 수집`,
                step: '판매 재고 수집'
            }, range, 'inventory-pages');
        }
    };
}

function compareProgressReporter(context, totalHint, range = { start: 0, end: 98 }) {
    let structuredSeen = false;
    return line => {
        const text = String(line || '');
        const structured = parseAutomationProgress(text);
        if (structured) {
            structuredSeen = true;
            reportProgressInRange(context, { ...structured, total: structured.total || totalHint || null }, range, 'compare');
            return;
        }
        if (structuredSeen) return;
        const match = text.match(/(\d+)\/(\d+)\s*가격 비교 완료/);
        if (!match) return;
        const current = Number(match[1]);
        const total = Number(match[2]) || totalHint || null;
        reportProgressInRange(context, { current, total, message: `${current} / ${total} 가격 비교`, step: '가격 비교' }, range, 'compare');
    };
}

function inventoryRowsForCompare(rows) {
    return rows.map(item => ({
        ...item,
        koreanName: item.productName,
        option: item.optionName,
        sellPrice: item.currentPrice,
        productCode: item.productId ? `(${item.productId})` : ''
    }));
}

async function executeInventorySync(context) {
    resetStop();
    sendLog('판매목록 동기화 시작');
    context.reportProgress({ current: 0, total: null, percent: 0, step: '대상 계산', etaKey: 'inventory', message: '판매중 재고 대상 계산 중' });
    try {
        await runScript('inventory.js', ['--sync-all'], inventoryProgressReporter(context));
        context.throwIfCancellationRequested();
        checkStop();
        const filePath = path.join(__dirname, 'inventory_all.json');
        const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        context.reportProgress({ current: items.length, total: items.length, percent: 97, step: 'DB 저장', etaKey: 'inventory-save', message: `${items.length}개 DB 저장 중` });
        const counts = inventoryDb.upsertInventory(items, true);
        inventoryDb.addHistory('INVENTORY_SYNC', 'SUCCESS', { total: items.length, ...counts });
        context.reportProgress({ current: items.length, total: items.length, percent: 100, step: 'DB 저장', etaKey: 'inventory-save', message: `총 ${items.length}개 저장 완료` });
        sendLog(`${counts.success}개 동기화 완료 / 실패 ${counts.failure}개`);
        sendSpecial('__INVENTORY_REFRESH__');
        return { total: items.length, ...counts };
    } catch (error) {
        if (!isStopError(error)) inventoryDb.addHistory('INVENTORY_SYNC', 'FAILED', {}, error.message);
        throw error;
    }
}

async function executeFullCompare(context) {
    resetStop();
    sendLog('가격 비교 시작');
    const active = inventoryDb.db.prepare("SELECT * FROM inventory_items WHERE saleStatus='ON_SALE' ORDER BY id").all();
    fs.writeFileSync(path.join(__dirname, 'inventory_all.json'), JSON.stringify(inventoryRowsForCompare(active), null, 2));
    context.reportProgress({ current: 0, total: active.length, percent: 0, step: '최저가 조회 준비', etaKey: 'compare', message: `전체 재고 ${active.length}개 가격 비교 시작` });
    await runScript('compareAll.js', [''], compareProgressReporter(context, active.length));
    context.throwIfCancellationRequested();
    checkStop();
    const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'inventory_result.json'), 'utf8'));
    ensureComparisonCoverage(results, active.map(item => item.stockId), '전체 가격 비교');
    const counts = inventoryDb.applyComparison(results);
    const snapshot = inventoryDb.targetSnapshot();
    inventoryDb.addHistory('PRICE_COMPARE', 'SUCCESS', { total: results.length, success: results.length - counts.failures, failure: counts.failures });
    context.reportProgress({ current: results.length, total: results.length, percent: 100, step: 'DB 저장', etaKey: 'compare-save', message: `가격 비교 ${results.length}개 완료` });
    sendLog('가격 비교 완료');
    sendLog(`수정 대상 계산: ${snapshot.count}개`);
    sendLog(`DB 수정 대상 저장 완료: ${snapshot.count}개`);
    sendLog(`가격 비교 결과: 하한가 도달 ${counts.floors}개 / 실패 ${counts.failures}개`);
    return { total: results.length, ...counts, targets: snapshot.count };
}

async function executeSelectedCompare(stockIds, selected, context) {
    resetStop();
    sendLog(`선택 재고 ${stockIds.length}개 가격 비교 시작`);
    fs.writeFileSync(path.join(__dirname, 'inventory_all.json'), JSON.stringify(inventoryRowsForCompare(selected), null, 2));
    context.reportProgress({ current: 0, total: stockIds.length, percent: 0, step: '최저가 조회 준비', etaKey: 'compare', message: `선택 재고 ${stockIds.length}개 가격 비교 시작` });
    await runScript('compareAll.js', ['--stock-ids', stockIds.join(',')], compareProgressReporter(context, stockIds.length));
    context.throwIfCancellationRequested();
    checkStop();
    const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'inventory_result.json'), 'utf8'));
    ensureComparisonCoverage(results, stockIds, '선택 가격 비교');
    const processedIds = new Set(results.map(item => String(item.stockId || '')));
    const counts = inventoryDb.applyComparison(results);
    const snapshot = inventoryDb.targetSnapshot();
    inventoryDb.addHistory('PRICE_COMPARE_SELECTED', 'SUCCESS', {
        total: results.length,
        success: results.length - counts.failures,
        failure: counts.failures
    });
    context.reportProgress({ current: results.length, total: results.length, percent: 100, step: 'DB 저장', etaKey: 'compare-save', message: `선택 재고 ${results.length}개 가격 비교 완료` });
    sendLog(`선택 재고 ${stockIds.length}개 가격 비교 완료`);
    sendLog(`선택 대상 갱신: ${results.length}개`);
    sendLog(`전체 수정 대상 현재: ${snapshot.count}개`);
    return { total: results.length, stockIds, processedStockIds: [...processedIds], totalTargets: snapshot.count, ...counts };
}

async function executePriceUpdates(items, context) {
    resetStop();
    let success = 0;
    let failure = 0;
    const startedAt = Date.now();
    sendLog(`[속도 설정] 가격 수정 동시 처리: 1 (저장 안정성 우선)`);
    currentBrowser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const browserContext = currentBrowser.contexts()[0];
    if (!browserContext) throw new Error('연결된 크롬 컨텍스트 없음. 크롬 원격 디버깅을 먼저 켜야 함.');
    context.reportProgress({ current: 0, total: items.length, percent: 0, step: '판매가 수정 준비', etaKey: 'price-update', message: `가격 수정 ${items.length}개 시작` });
    for (let index = 0; index < items.length; index++) {
        context.throwIfCancellationRequested();
        const { stockId, newPrice } = items[index];
        context.reportProgress({
            current: index,
            total: items.length,
            step: '판매가 수정',
            etaKey: 'price-update',
            message: `${index + 1}/${items.length} · stockId ${stockId} 판매가 수정 중`
        });
        try {
            await openKreamStockEdit(stockId, newPrice, browserContext);
            inventoryDb.markUpdate(stockId, 'COMPLETED', null, newPrice);
            success++;
            sendLog(`가격 수정 완료: stockId=${stockId}`);
        } catch (error) {
            if (isStopError(error) || context.isCancellationRequested()) throw error;
            failure++;
            inventoryDb.markUpdate(stockId, 'FAILED', error.message);
            sendLog(`가격 수정 실패: stockId=${stockId}, ${error.message}`);
        }
        context.reportProgress({
            current: index + 1,
            total: items.length,
            step: '판매가 수정',
            etaKey: 'price-update',
            message: `${index + 1}/${items.length} · stockId ${stockId} 가격 수정 완료`
        });
    }
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    sendLog(`[가격수정 요약] 총 상품=${items.length} 실제 수정=${success} 실패=${failure} 총=${elapsedSeconds.toFixed(2)}초 평균=${items.length ? (elapsedSeconds / items.length).toFixed(2) : '0.00'}초/건`);
    currentBrowser = null;
    sendSpecial('__INVENTORY_REFRESH__');
    return { total: items.length, success, failure };
}

async function executeAllTargetPriceUpdates(context) {
    const snapshot = inventoryDb.targetSnapshot();
    sendLog(`전체 자동수정 실행 대상: ${snapshot.count}개`);
    context.reportProgress({ current: 0, total: snapshot.count || null, percent: 0, step: '수정 대상 조회', etaKey: 'price-update', message: `DB 최신 수정 대상 ${snapshot.count}개 확인` });
    if (!snapshot.count) return { total: 0, success: 0, failure: 0 };
    return executePriceUpdates(snapshot.items.map(item => ({
        stockId: String(item.stockId),
        newPrice: Number(item.targetPrice)
    })), context);
}

async function executeLegacyFlow(keywords, context) {
    resetStop();
    const list = Array.isArray(keywords) ? keywords : [keywords];
    let processed = 0;
    context.reportProgress({ current: 0, total: null, percent: 0, step: '대상 계산', etaKey: 'legacy-prepare', message: `${list.join(', ')} 대상 계산 중` });
    for (let index = 0; index < list.length; index++) {
        context.throwIfCancellationRequested();
        const range = { start: (index / list.length) * 100, end: ((index + 1) / list.length) * 100 };
        const result = await runKreamFlow(list[index], context, range);
        processed += Number(result?.total) || 0;
    }
    return { total: processed, keywords: list };
}

app.get('/run/pokemon', (req, res) => {
    return enqueueAutomation(req, res, {
        type: 'legacy-pokemon',
        label: '포켓몬 실행',
        run: context => executeLegacyFlow('포켓몬', context)
    });
});

app.get('/run/onepiece', (req, res) => {
    return enqueueAutomation(req, res, {
        type: 'legacy-onepiece',
        label: '원피스 실행',
        run: context => executeLegacyFlow('원피스', context)
    });
});

app.get('/run/all', (req, res) => {
    return enqueueAutomation(req, res, {
        type: 'legacy-all',
        label: '기존 전체 실행',
        run: context => executeLegacyFlow(['포켓몬', '원피스'], context)
    });
});

app.get('/api/targets', (req, res) => {
    try {
        const type = req.query.type || 'all';
        const targetFile = getTargetFile(type);
        const items = canonicalTargetsForType(type).map(toLegacyTarget);

        res.setHeader('Cache-Control', 'no-store');
        res.json({
            success: true,
            type,
            file: `DB inventory_items (${targetFile} 호환)`,
            items
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/api/open-stock-edit', (req, res) => {
    try {
        const stockId = String(req.query.stockId || '').trim();
        const newPrice = parsePrice(req.query.newPrice);

        if (!stockId) {
            return res.status(400).json({
                success: false,
                message: 'stockId 없음'
            });
        }

        if (!newPrice || newPrice <= 0) {
            return res.status(400).json({
                success: false,
                message: 'newPrice 없음'
            });
        }

        return enqueueAutomation(req, res, {
            type: 'price-update',
            label: '판매가 수정',
            metadata: { count: 1 },
            run: context => executePriceUpdates([{ stockId, newPrice }], context)
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/api/stop', express.json(), stopAllQueueTasks);

// KREAM BOT v2 DB-backed inventory API. Existing automation endpoints above remain compatible.
app.get('/api/inventory', (req, res) => {
    try { res.json({ success: true, ...inventoryDb.listInventory(req.query) }); }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/dashboard/summary', (req, res) => {
    try { res.json({ success: true, summary: inventoryDb.summary() }); }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/inventory/targets', (req, res) => {
    try {
        const snapshot = inventoryDb.targetSnapshot();
        res.setHeader('Cache-Control', 'no-store');
        sendLog(`수정 대상 API 응답: ${snapshot.count}개`);
        res.json({ success: true, items: snapshot.items, count: snapshot.count, comparisonComplete: true });
    }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.patch('/api/inventory/:stockId/floor-price', express.json(), (req, res) => {
    try {
        const floorPrice = inventoryDb.saveFloorPrice(String(req.params.stockId), req.body?.floorPrice);
        sendLog(`하한가 저장 완료: stockId=${req.params.stockId}, ${floorPrice === null ? '미설정' : `${formatPrice(floorPrice)}원`}`);
        res.json({ success: true, stockId: req.params.stockId, floorPrice });
    } catch (err) {
        sendLog(`하한가 저장 실패: ${err.message}`);
        res.status(400).json({ success: false, message: err.message });
    }
});

app.post('/api/inventory/lower-prices', express.json(), (req, res) => {
    try {
        const items = inventoryDb.saveFloorPrices(req.body?.items);
        sendLog(`하한가 저장 완료: ${items.length}개`);
        res.json({ success: true, count: items.length, items });
    } catch (err) {
        sendLog(`하한가 일괄 저장 실패: ${err.message}`);
        res.status(400).json({ success: false, message: err.message });
    }
});

app.post('/api/inventory/sync', express.json(), (req, res) => {
    return enqueueAutomation(req, res, {
        type: 'inventory-sync',
        label: '판매목록 동기화',
        run: executeInventorySync
    });
});

app.post('/api/inventory/compare', express.json(), (req, res) => {
    return enqueueAutomation(req, res, {
        type: 'price-compare-all',
        label: '전체 가격 비교',
        run: executeFullCompare
    });
});

app.post('/api/compare-selected', express.json(), (req, res) => {
    const stockIds = [...new Set((Array.isArray(req.body?.stockIds) ? req.body.stockIds : [])
        .map(value => String(value || '').trim()).filter(Boolean))];
    if (!stockIds.length) return res.status(400).json({ success: false, message: '가격 비교할 재고를 선택하세요.' });

    try {
        const placeholders = stockIds.map(() => '?').join(',');
        const selected = inventoryDb.db.prepare(
            `SELECT * FROM inventory_items WHERE saleStatus='ON_SALE' AND stockId IN (${placeholders})`
        ).all(...stockIds);
        if (selected.length !== stockIds.length) {
            const found = new Set(selected.map(item => item.stockId));
            const missing = stockIds.filter(stockId => !found.has(stockId));
            return res.status(400).json({ success: false, message: `판매중 재고를 찾을 수 없습니다: ${missing.join(', ')}` });
        }
        return enqueueAutomation(req, res, {
            type: 'price-compare-selected',
            label: '선택 가격 비교',
            metadata: { count: stockIds.length },
            run: context => executeSelectedCompare(stockIds, selected, context)
        });
    } catch (err) {
        sendLog(`선택 재고 가격 비교 실패: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/inventory/update-prices', express.json(), (req, res) => {
    if (req.body?.allTargets === true) {
        const snapshot = inventoryDb.targetSnapshot();
        if (!snapshot.count) return res.status(400).json({ success: false, message: '가격 수정 대상이 없습니다.' });
        return enqueueAutomation(req, res, {
            type: 'price-update',
            label: '전체 자동수정',
            metadata: { count: snapshot.count, source: 'database' },
            run: executeAllTargetPriceUpdates
        });
    }

    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = rawItems.map(item => ({
        stockId: String(item?.stockId || '').trim(),
        newPrice: parsePrice(item?.newPrice ?? item?.targetPrice)
    }));
    if (!items.length) return res.status(400).json({ success: false, message: '가격 수정 대상이 없습니다.' });
    if (items.some(item => !item.stockId || !item.newPrice)) {
        return res.status(400).json({ success: false, message: 'stockId 또는 수정 가격이 올바르지 않습니다.' });
    }
    if (new Set(items.map(item => item.stockId)).size !== items.length) {
        return res.status(400).json({ success: false, message: '중복된 stockId가 있습니다.' });
    }
    return enqueueAutomation(req, res, {
        type: 'price-update',
        label: items.length === 1 ? '판매가 수정' : '전체 자동수정',
        metadata: { count: items.length },
        run: context => executePriceUpdates(items, context)
    });
});

app.get('/api/queue', (req, res) => {
    res.json({ success: true, queue: taskQueue.getSnapshot() });
});

async function cancelQueueJobById(req, res, id) {
    try {
        const job = taskQueue.get(String(id || ''));
        if (!job || ![QUEUE_STATUS.WAITING, QUEUE_STATUS.RUNNING].includes(job.status)) {
            return res.status(404).json({ success: false, message: '취소할 작업을 찾을 수 없습니다.' });
        }
        const canceled = await taskQueue.cancel(job.id);
        return res.json({ success: true, job: canceled });
    } catch (error) {
        if (error instanceof TaskNotFoundError) {
            return res.status(404).json({ success: false, message: error.message });
        }
        return systemApiError(res, error);
    }
}

async function cancelQueueJob(req, res) {
    return cancelQueueJobById(req, res, req.params.id);
}

async function stopAllQueueTasks(req, res) {
    if (stopAllPromise) {
        try {
            await stopAllPromise;
            return res.json({ success: true, message: '작업 중지 완료', queue: taskQueue.getSnapshot() });
        } catch (error) {
            return systemApiError(res, error);
        }
    }

    const before = taskQueue.getSnapshot();
    sendLog('작업 중지 요청');
    if (before.current) sendLog('현재 작업 취소');
    sendLog(`대기열 ${before.waiting.length}개 제거`);

    stopAllPromise = taskQueue.cancelAll();
    try {
        const result = await stopAllPromise;
        sendLog('작업 중지 완료');
        sendSpecial('__INVENTORY_REFRESH__');
        sendSpecial('__TARGETS_REFRESH__');
        return res.json({ success: true, message: '작업 중지 완료', result, queue: taskQueue.getSnapshot() });
    } catch (error) {
        sendLog(`작업 중지 실패: ${error.message}`);
        return systemApiError(res, error);
    } finally {
        stopAllPromise = null;
    }
}

app.post('/api/queue/:id/cancel', express.json(), cancelQueueJob);

function systemApiError(res, error, status = 500) {
    const message = maskText(error?.message || error || '시스템 작업에 실패했습니다.').slice(0, 500);
    fileLogger.write('error', message);
    return res.status(status).json({ success: false, message });
}

app.get('/api/system/status', async (req, res) => {
    try { res.json({ success: true, ...(await systemManager.getStatus()) }); }
    catch (error) { systemApiError(res, error); }
});

app.get('/api/system/version', async (req, res) => {
    try { res.json({ success: true, version: await systemManager.getVersion(false) }); }
    catch (error) { systemApiError(res, error); }
});

app.post('/api/system/check-update', async (req, res) => {
    try {
        const version = await systemManager.getVersion(true);
        fileLogger.write('update', version.gitError ? `업데이트 확인 실패: ${version.gitError}` : `업데이트 확인 완료: behind=${version.behind}`);
        res.json({ success: true, version });
    } catch (error) { systemApiError(res, error); }
});

app.post('/api/system/apply-update', express.json(), async (req, res) => {
    try {
        const version = await systemManager.getVersion(false);
        if (version.dirty) return res.status(409).json({ success: false, message: '로컬 변경사항이 있어 안전을 위해 업데이트를 차단했습니다. 변경사항을 커밋하거나 정리한 뒤 다시 시도하세요.' });
        const result = systemManager.requestUpdate('Manual');
        res.status(202).json({ success: true, accepted: result.accepted, message: '업데이트 작업을 시작했습니다. 검증 후 서비스가 자동으로 재시작됩니다.' });
    } catch (error) { systemApiError(res, error, /진행 중|작업/.test(error.message) ? 409 : 500); }
});

app.post('/api/system/restart', express.json(), (req, res) => {
    try {
        const result = systemManager.requestRestart();
        res.status(202).json({ success: true, accepted: result.accepted, message: '서비스 재시작 요청을 접수했습니다.' });
    } catch (error) { systemApiError(res, error, /진행 중/.test(error.message) ? 409 : 500); }
});

app.get('/api/system/chrome-status', async (req, res) => {
    try { res.json({ success: true, chrome: await systemManager.getChromeStatus() }); }
    catch (error) { systemApiError(res, error); }
});

app.get('/api/system/info', async (req, res) => {
    try { res.json({ success: true, info: await systemManager.getSystemInfo() }); }
    catch (error) { systemApiError(res, error); }
});

app.get('/api/system/logs', (req, res) => {
    try { res.json({ success: true, ...fileLogger.read(String(req.query.type || 'app'), { lines: req.query.lines, search: req.query.search }) }); }
    catch (error) { systemApiError(res, error, 400); }
});

app.get('/api/system/logs/download', (req, res) => {
    try {
        const file = fileLogger.getLogPath(String(req.query.type || 'app'));
        if (!fs.existsSync(file)) return res.status(404).json({ success: false, message: '로그 파일이 없습니다.' });
        res.download(file, path.basename(file));
    } catch (error) { systemApiError(res, error, 400); }
});

app.delete('/api/system/logs/:type', (req, res) => {
    try {
        fileLogger.clear(String(req.params.type));
        res.json({ success: true, message: '로그를 삭제했습니다.' });
    } catch (error) { systemApiError(res, error, 400); }
});

app.post('/api/system/backup', express.json(), (req, res) => {
    try {
        const backup = systemManager.createBackup();
        sendLog(`DB 백업 완료: ${backup.name}`);
        res.json({ success: true, backup });
    } catch (error) { systemApiError(res, error); }
});

app.get('/api/system/backups', (req, res) => {
    try { res.json({ success: true, items: systemManager.listBackups(), retention: readSettings().backupRetention }); }
    catch (error) { systemApiError(res, error); }
});

app.get('/api/system/backups/:name/download', (req, res) => {
    try {
        const file = systemManager.getBackupPath(req.params.name);
        res.download(file, path.basename(file));
    } catch (error) { systemApiError(res, error, 404); }
});

app.delete('/api/system/backups/:name', (req, res) => {
    try { res.json({ success: true, name: systemManager.deleteBackup(req.params.name) }); }
    catch (error) { systemApiError(res, error, 400); }
});

app.post('/api/system/backups/retention', express.json(), (req, res) => {
    try { res.json({ success: true, settings: systemManager.updateBackupRetention(req.body?.retention) }); }
    catch (error) { systemApiError(res, error, 400); }
});

app.get('/api/system/update-history', (req, res) => {
    try { res.json({ success: true, items: readUpdateHistory().slice(0, 50) }); }
    catch (error) { systemApiError(res, error); }
});

app.get('/api/system/auto-update', (req, res) => {
    res.json({ success: true, settings: readSettings() });
});

app.post('/api/system/auto-update', express.json(), async (req, res) => {
    try {
        const allowed = ['autoUpdateEnabled', 'autoUpdateTime', 'autoApply', 'deferWhenBusy', 'rollbackOnFailure'];
        const input = Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(req.body || {}, key)).map(key => [key, req.body[key]]));
        const result = await systemManager.updateAutoUpdateSettings(input);
        res.json({ success: true, settings: result.settings });
    } catch (error) { systemApiError(res, error, 400); }
});

app.post('/api/stop', express.json(), stopAllQueueTasks);

app.listen(systemConfig.PORT, () => {
    console.log('========================');
    console.log('KREAM BOT');
    console.log(`http://localhost:${systemConfig.PORT}`);
    console.log('========================');
    fileLogger.write('app', `KREAM BOT 시작: port=${systemConfig.PORT}, pid=${process.pid}`);
});
