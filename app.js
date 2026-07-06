const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { chromium } = require('playwright');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

let clients = [];

let stopRequested = false;
let currentChild = null;
let currentPage = null;
let currentBrowser = null;

function sendSse(text) {
    const msg = String(text);

    clients.forEach(client => {
        client.write(`data: ${msg.replace(/\r?\n/g, '\\n')}\n\n`);
    });
}

function sendLog(text) {
    const msg = String(text);

    process.stdout.write(msg.endsWith('\n') ? msg : msg + '\n');
    sendSse(msg);
}

function sendSpecial(text) {
    sendSse(text);
}

function resetStop() {
    stopRequested = false;
}

function requestStop() {
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
        currentPage.close().catch(() => {});
        sendLog('현재 Playwright 페이지 종료 요청');
    }
}

function checkStop() {
    if (stopRequested) {
        throw new Error('사용자 중지 요청으로 작업 종료');
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

function handleScriptLine(line) {
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

    sendLog(text);
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

        sendLog(`===== ${scriptName} 시작 =====`);

        currentChild = spawn('node', [scriptName, ...args], {
            cwd: __dirname,
            shell: true
        });

        let stdoutBuffer = '';
        let stderrBuffer = '';
        let finishedByStop = false;

        currentChild.stdout.on('data', data => {
            stdoutBuffer += data.toString();

            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop();

            lines.forEach(line => {
                handleScriptLine(line);
            });
        });

        currentChild.stderr.on('data', data => {
            stderrBuffer += data.toString();

            const lines = stderrBuffer.split(/\r?\n/);
            stderrBuffer = lines.pop();

            lines.forEach(line => {
                sendLog('[ERROR] ' + line);
            });
        });

        currentChild.on('close', code => {
            if (stdoutBuffer.trim()) {
                handleScriptLine(stdoutBuffer);
            }

            if (stderrBuffer.trim()) {
                sendLog('[ERROR] ' + stderrBuffer);
            }

            if (stopRequested) {
                finishedByStop = true;
                sendLog(`===== ${scriptName} 중지됨 =====`);
                currentChild = null;
                reject(new Error('사용자 중지 요청으로 작업 종료'));
                return;
            }

            sendLog(`===== ${scriptName} 종료 (${code}) =====`);

            currentChild = null;

            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${scriptName} 실패 (종료코드 ${code})`));
            }
        });

        currentChild.on('error', err => {
            currentChild = null;

            if (finishedByStop || stopRequested) {
                reject(new Error('사용자 중지 요청으로 작업 종료'));
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

    await runScript('inventory.js', [keyword]);
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

        res.json({
            success: true,
            stockId,
            newPrice
        });

    } catch (err) {
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
        message: '전체 작업 중지 요청 완료'
    });
});

app.listen(3000, () => {
    console.log('========================');
    console.log('KREAM BOT');
    console.log('http://localhost:3000');
    console.log('========================');
});