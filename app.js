const express = require('express');
const path = require('path');
const fs = require('fs');
const inventoryDb = require('./database');
const { spawn, exec } = require('child_process');
const { chromium } = require('playwright');
const fileLogger = require('./system/file-logger');
const {
    SystemManager,
    readSettings,
    readUpdateHistory,
    maskText,
    config: systemConfig
} = require('./system/system-manager');

const app = express();

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

const systemManager = new SystemManager({
    inventoryDb,
    chromium,
    getJobState: () => ({
        busy: Boolean(currentChild || currentPage),
        name: currentJobName || (currentPage ? 'KREAM 재고 수정' : null),
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

function resetStop() {
    stopRequested = false;
}

function requestStop() {
    if (stopRequested) {
        sendSpecial('__STOP_REQUESTED__');
        return;
    }

    stopRequested = true;

    sendLog('🛑 전체 작업 중지 요청 수신');
    sendSpecial('__STOP_REQUESTED__');

    if (currentChild && currentChild.pid) {
        try {
            exec(`taskkill /pid ${currentChild.pid} /T /F`, () => {});
            sendLog(`실행중인 node 작업 종료 요청: pid=${currentChild.pid}`);
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

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

function runScript(scriptName, args = []) {
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

async function runKreamFlow(keyword) {
    const type = getTypeByKeyword(keyword);

    checkStop();

    sendLog(`${keyword} 실행 시작`);
    sendSpecial(`__RUN_START__:${type}`);

    // Legacy flows keep their explicit keyword; inventory sync uses --sync-all separately.
    await runScript('inventory.js', ['--keyword', keyword]);
    checkStop();

    await runScript('compareAll.js', [keyword]);
    checkStop();

    await runScript('filterTargets.js', [keyword]);
    checkStop();

    sendLog(`${keyword} 작업 완료`);
    sendSpecial(`__RUN_DONE__:${type}`);
    sendSpecial(`__REFRESH_TARGETS__:${type}`);
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

    await waitWithStop(page, 3000);
}

async function safeFillPrice(page, priceInput, newPrice, stockId) {
    checkStop();

    const priceText = String(Number(newPrice));

    await priceInput.click({ timeout: 5000 });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await waitWithStop(page, 300);
    await priceInput.fill('');
    await priceInput.type(priceText, { delay: 30 });
    await waitWithStop(page, 700);

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

    await waitWithStop(page, 2000);

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

    await waitWithStop(page, 1000);

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

async function openKreamStockEdit(stockId, newPrice) {
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

    currentBrowser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const context = currentBrowser.contexts()[0];

    if (!context) {
        throw new Error('연결된 크롬 컨텍스트 없음. 크롬 원격 디버깅을 먼저 켜야 함.');
    }

    currentPage = await context.newPage();

    try {
        checkStop();

        await currentPage.goto('https://partner.kream.co.kr/business/ask-sales', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await waitWithStop(currentPage, 2000);

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
            await waitWithStop(currentPage, 3000);
        } else {
            sendLog('검색창을 못 찾아서 현재 목록에서 stockId 직접 탐색');
        }

        checkStop();

        const stockText = currentPage.getByText(String(stockId), { exact: true }).first();

        await stockText.waitFor({
            state: 'visible',
            timeout: 15000
        });

        sendLog(`stockId 화면 확인 완료: ${stockId}`);

        checkStop();

        const row = stockText.locator('xpath=ancestor::div[contains(@class, "Table_row__")][1]');

        if (!(await row.count())) {
            throw new Error(`stockId 행을 찾지 못함: ${stockId}`);
        }

        sendLog(`stockId 행 찾기 완료: ${stockId}`);

        checkStop();

        await clickRealRowEditButton(currentPage, row, stockId);

        sendLog(`해당 행 재고 수정 버튼 클릭 완료: ${stockId}`);

        checkStop();

        await applyStockEdit(currentPage, stockId, targetPrice);

    } finally {
        if (currentPage) {
            await currentPage.close().catch(() => {});
            currentPage = null;
        }
    }
}

app.get('/run/pokemon', async (req, res) => {
    try {
        resetStop();

        await runKreamFlow('포켓몬');

        res.json({
            success: true,
            redirect: '/target_view.html?type=pokemon'
        });

    } catch (err) {
        if (isStopError(err)) {
            sendLog('작업 중지 : ' + STOP_MESSAGE);
            return sendStoppedResponse(res);
        }

        sendLog('작업 실패 : ' + err.message);

        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/run/onepiece', async (req, res) => {
    try {
        resetStop();

        await runKreamFlow('원피스');

        res.json({
            success: true,
            redirect: '/target_view.html?type=onepiece'
        });

    } catch (err) {
        if (isStopError(err)) {
            sendLog('작업 중지 : ' + STOP_MESSAGE);
            return sendStoppedResponse(res);
        }

        sendLog('작업 실패 : ' + err.message);

        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/run/all', async (req, res) => {
    try {
        resetStop();

        await runKreamFlow('포켓몬');

        checkStop();

        await runKreamFlow('원피스');

        res.json({
            success: true,
            redirect: '/target_view.html?type=pokemon'
        });

    } catch (err) {
        if (isStopError(err)) {
            sendLog('전체 실행 중지 : ' + STOP_MESSAGE);
            return sendStoppedResponse(res);
        }

        sendLog('전체 실행 실패 : ' + err.message);

        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/api/targets', (req, res) => {
    try {
        const type = req.query.type || 'all';
        const targetFile = getTargetFile(type);
        const filePath = path.join(__dirname, targetFile);

        if (!fs.existsSync(filePath)) {
            return res.json({
                success: true,
                type,
                file: targetFile,
                items: []
            });
        }

        const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        res.json({
            success: true,
            type,
            file: targetFile,
            items
        });

    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/api/open-stock-edit', async (req, res) => {
    try {
        resetStop();

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

        await openKreamStockEdit(stockId, newPrice);
        inventoryDb.markUpdate(stockId, 'COMPLETED', null, newPrice);

        res.json({
            success: true,
            stockId,
            newPrice
        });

    } catch (err) {
        if (isStopError(err)) {
            sendLog('재고 수정 중지 : ' + STOP_MESSAGE);
            return sendStoppedResponse(res);
        }

        sendLog('재고 수정 실패 : ' + err.message);

        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/api/stop', (req, res) => {
    requestStop();

    res.json({
        success: true,
        stopped: true,
        message: '전체 작업 중지 요청 완료'
    });
});

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
    try { res.json({ success: true, items: inventoryDb.targets(), comparisonComplete: true }); }
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

app.post('/api/inventory/sync', async (req, res) => {
    if (currentChild) return res.status(409).json({ success: false, message: '다른 작업이 진행 중입니다.' });
    try {
        resetStop(); sendLog('판매목록 동기화 시작');
        // Dedicated all-inventory mode. Never reuse the Pokemon/One Piece keyword path.
        await runScript('inventory.js', ['--sync-all']); checkStop();
        const filePath = path.join(__dirname, 'inventory_all.json');
        const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const counts = inventoryDb.upsertInventory(items, true);
        inventoryDb.addHistory('INVENTORY_SYNC', 'SUCCESS', { total: items.length, ...counts });
        sendLog(`${counts.success}개 동기화 완료 / 실패 ${counts.failure}개`);
        sendSpecial('__INVENTORY_REFRESH__');
        res.json({ success: true, total: items.length, ...counts });
    } catch (err) {
        if (isStopError(err)) return sendStoppedResponse(res);
        inventoryDb.addHistory('INVENTORY_SYNC', 'FAILED', {}, err.message);
        sendLog(`판매목록 동기화 실패: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/inventory/compare', async (req, res) => {
    if (currentChild) return res.status(409).json({ success: false, message: '다른 작업이 진행 중입니다.' });
    try {
        resetStop(); sendLog('가격 비교 시작');
        const active = inventoryDb.db.prepare("SELECT * FROM inventory_items WHERE saleStatus='ON_SALE' ORDER BY id").all();
        fs.writeFileSync(path.join(__dirname, 'inventory_all.json'), JSON.stringify(active.map(i => ({...i,koreanName:i.productName,option:i.optionName,sellPrice:i.currentPrice,productCode:i.productId ? `(${i.productId})` : ''})), null, 2));
        await runScript('compareAll.js', ['']); checkStop();
        const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'inventory_result.json'), 'utf8'));
        const counts = inventoryDb.applyComparison(results);
        inventoryDb.addHistory('PRICE_COMPARE', 'SUCCESS', { total: results.length, success: results.length-counts.failures, failure: counts.failures });
        sendLog(`가격 비교 완료: 수정 대상 ${counts.targets}개 / 하한가 도달 ${counts.floors}개 / 실패 ${counts.failures}개`);
        sendSpecial('__TARGETS_REFRESH__');
        res.json({ success: true, total: results.length, ...counts });
    } catch (err) {
        if (isStopError(err)) return sendStoppedResponse(res);
        sendLog(`가격 비교 실패: ${err.message}`); res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/compare-selected', express.json(), async (req, res) => {
    if (currentChild) return res.status(409).json({ success: false, message: '다른 작업이 진행 중입니다.' });

    const stockIds = [...new Set((Array.isArray(req.body?.stockIds) ? req.body.stockIds : [])
        .map(value => String(value || '').trim()).filter(Boolean))];
    if (!stockIds.length) return res.status(400).json({ success: false, message: '가격 비교할 재고를 선택하세요.' });

    try {
        resetStop();
        const placeholders = stockIds.map(() => '?').join(',');
        const selected = inventoryDb.db.prepare(
            `SELECT * FROM inventory_items WHERE saleStatus='ON_SALE' AND stockId IN (${placeholders})`
        ).all(...stockIds);
        if (selected.length !== stockIds.length) {
            const found = new Set(selected.map(item => item.stockId));
            const missing = stockIds.filter(stockId => !found.has(stockId));
            return res.status(400).json({ success: false, message: `판매중 재고를 찾을 수 없습니다: ${missing.join(', ')}` });
        }

        sendLog(`선택 재고 ${stockIds.length}개 가격 비교 시작`);
        fs.writeFileSync(path.join(__dirname, 'inventory_all.json'), JSON.stringify(selected.map(i => ({
            ...i, koreanName: i.productName, option: i.optionName, sellPrice: i.currentPrice,
            productCode: i.productId ? `(${i.productId})` : ''
        })), null, 2));

        await runScript('compareAll.js', ['--stock-ids', stockIds.join(',')]);
        checkStop();
        const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'inventory_result.json'), 'utf8'));
        const processedIds = new Set(results.map(item => String(item.stockId || '')));
        if (results.length !== stockIds.length || stockIds.some(stockId => !processedIds.has(stockId))) {
            throw new Error(`선택 비교 결과 불일치: 요청 ${stockIds.length}개, 처리 ${results.length}개`);
        }

        const counts = inventoryDb.applyComparison(results);
        inventoryDb.addHistory('PRICE_COMPARE_SELECTED', 'SUCCESS', {
            total: results.length, success: results.length - counts.failures, failure: counts.failures
        });
        sendLog(`선택 재고 ${stockIds.length}개 가격 비교 완료`);
        sendSpecial('__TARGETS_REFRESH__');
        res.json({ success: true, total: results.length, stockIds, processedStockIds: [...processedIds], ...counts });
    } catch (err) {
        if (isStopError(err)) return sendStoppedResponse(res);
        sendLog(`선택 재고 가격 비교 실패: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
});

// System management APIs are isolated from the existing inventory routes above.
function requireSystemAdmin(req, res, next) {
    const verification = systemManager.adminPin.verify(req.ip, req.get('x-kream-admin-pin'));
    if (!verification.ok) {
        fileLogger.write('error', `관리자 인증 실패: ip=${req.ip}, status=${verification.status}`);
        return res.status(verification.status).json({ success: false, message: verification.message });
    }
    next();
}

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

app.post('/api/system/apply-update', express.json(), requireSystemAdmin, async (req, res) => {
    try {
        const version = await systemManager.getVersion(false);
        if (version.dirty) return res.status(409).json({ success: false, message: '로컬 변경사항이 있어 안전을 위해 업데이트를 차단했습니다. 변경사항을 커밋하거나 정리한 뒤 다시 시도하세요.' });
        const result = systemManager.requestUpdate('Manual');
        res.status(202).json({ success: true, accepted: result.accepted, message: '업데이트 작업을 시작했습니다. 검증 후 서비스가 자동으로 재시작됩니다.' });
    } catch (error) { systemApiError(res, error, /진행 중|작업/.test(error.message) ? 409 : 500); }
});

app.post('/api/system/restart', express.json(), requireSystemAdmin, (req, res) => {
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

app.delete('/api/system/logs/:type', requireSystemAdmin, (req, res) => {
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

app.delete('/api/system/backups/:name', requireSystemAdmin, (req, res) => {
    try { res.json({ success: true, name: systemManager.deleteBackup(req.params.name) }); }
    catch (error) { systemApiError(res, error, 400); }
});

app.post('/api/system/backups/retention', express.json(), requireSystemAdmin, (req, res) => {
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

app.post('/api/system/auto-update', express.json(), requireSystemAdmin, async (req, res) => {
    try {
        const allowed = ['autoUpdateEnabled', 'autoUpdateTime', 'autoApply', 'deferWhenBusy', 'rollbackOnFailure'];
        const input = Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(req.body || {}, key)).map(key => [key, req.body[key]]));
        const result = await systemManager.updateAutoUpdateSettings(input);
        res.json({ success: true, settings: result.settings });
    } catch (error) { systemApiError(res, error, 400); }
});

app.post('/api/stop', (req, res) => { requestStop(); res.json({ success: true, stopped: true }); });

app.listen(systemConfig.PORT, () => {
    console.log('========================');
    console.log('KREAM BOT');
    console.log(`http://localhost:${systemConfig.PORT}`);
    console.log('========================');
    fileLogger.write('app', `KREAM BOT 시작: port=${systemConfig.PORT}, pid=${process.pid}`);
});
