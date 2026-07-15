const pokemonBtn = document.getElementById('pokemonBtn');
const onepieceBtn = document.getElementById('onepieceBtn');
const allBtn = document.getElementById('allBtn');
const stopBtn = document.getElementById('stopBtn');

const statusBox = document.getElementById('status');
const logBox = document.getElementById('log');

const STOP_BUTTON_LABEL = '전체 작업 중지';
const AUTO_EDIT_LABEL = '전체 자동수정';

let currentType = 'all';
let currentTargets = [];
let liveTargetCount = 0;
let isRunning = false;
let isAutoEditing = false;
let isStopRequested = false;

let eventSource = null;

function appendLog(text) {
    if (!logBox) return;

    logBox.textContent += text + '\n';
    logBox.scrollTop = logBox.scrollHeight;
}

function setStatus(text) {
    if (!statusBox) return;
    statusBox.textContent = text;
}

function isFetchFailure(message) {
    const text = String(message || '').toLowerCase();

    return (
        text.includes('failed to fetch') ||
        text.includes('load failed') ||
        text.includes('networkerror')
    );
}

function isClosedPageMessage(message) {
    const text = String(message || '').toLowerCase();

    return (
        text.includes('target page') ||
        text.includes('context or browser has been closed') ||
        text.includes('browser has been closed') ||
        text.includes('page has been closed') ||
        text.includes('target closed')
    );
}

function isStopLikeError(message) {
    const text = String(message || '').toLowerCase();

    return (
        isStopRequested ||
        text.includes('중지') ||
        text.includes('stop') ||
        isClosedPageMessage(text)
    );
}

function reportSoftError(message, statusText = '연결 일시 오류 / 재시도 가능') {
    if (isStopRequested) {
        appendLog(`[중지됨] ${message}`);
        return;
    }

    appendLog(`[오류] ${message}`);
    setStatus(statusText);
}

function setStopButtonReady() {
    if (!stopBtn) return;

    stopBtn.disabled = false;
    stopBtn.textContent = STOP_BUTTON_LABEL;
    stopBtn.style.opacity = '1';
    stopBtn.style.cursor = 'pointer';
}

function setAutoEditButtonReady() {
    const autoButton = document.getElementById('autoEditAllBtn');

    if (!autoButton) return;

    autoButton.disabled = false;
    autoButton.textContent = AUTO_EDIT_LABEL;
    autoButton.style.opacity = '1';
    autoButton.style.cursor = 'pointer';
}

function markStopRequested(message = '전체 작업 중지 요청 완료') {
    isRunning = false;
    isAutoEditing = false;
    isStopRequested = true;

    setAutoEditButtonReady();
    setStopButtonReady();
    setStatus(message);
}

function resetStopState() {
    isStopRequested = false;
    setStopButtonReady();
}

function getTargetKey(item) {
    if (!item) return '';

    return [
        item.stockId || '',
        item.productId || '',
        item.productCode || '',
        item.option || '',
        item.koreanName || ''
    ].join('|');
}

function mergeTargets(existingItems, incomingItems) {
    const merged = [];
    const indexByKey = new Map();

    existingItems.forEach(item => {
        const key = getTargetKey(item);
        if (!key) return;

        indexByKey.set(key, merged.length);
        merged.push(item);
    });

    incomingItems.forEach(item => {
        const key = getTargetKey(item);
        if (!key) return;

        if (indexByKey.has(key)) {
            merged[indexByKey.get(key)] = {
                ...merged[indexByKey.get(key)],
                ...item
            };
            return;
        }

        indexByKey.set(key, merged.length);
        merged.push(item);
    });

    return merged;
}

function getResponseTargets(data) {
    if (Array.isArray(data?.targets)) return data.targets;
    if (Array.isArray(data?.items)) return data.items;
    return null;
}

function connectLog() {
    eventSource = new EventSource('/logs');

    eventSource.onopen = () => {
        appendLog('[로그 연결됨]');
    };

    eventSource.onmessage = event => {
        const text = event.data.replace(/\\n/g, '\n');
        const isSpecial = handleSpecialMessage(text);

        if (isSpecial) {
            return;
        }

        appendLog(text);
    };

    eventSource.onerror = () => {
        if (!isStopRequested) {
            appendLog('[로그 연결 오류]');
        }
    };
}

connectLog();

function parsePrice(value) {
    const n = Number(String(value || '').replace(/[^\d]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

function formatPrice(value) {
    return Number(value || 0).toLocaleString('ko-KR');
}

function decodeBase64Utf8(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return new TextDecoder('utf-8').decode(bytes);
}

function handleSpecialMessage(text) {
    let handled = false;
    const messages = text.split('\n');

    messages.forEach(msg => {
        if (msg.startsWith('__TARGET_FOUND_B64__:')) {
            handled = true;

            const base64 = msg.replace('__TARGET_FOUND_B64__:', '');

            try {
                const jsonText = decodeBase64Utf8(base64);
                const item = JSON.parse(jsonText);
                addLiveTarget(item);
            } catch (err) {
                appendLog(`[TARGET_FOUND 파싱 실패] ${err.message}`);
            }
        }

        if (msg.startsWith('__REFRESH_TARGETS__:')) {
            handled = true;

            if (isStopRequested) {
                return;
            }

            const type = msg.replace('__REFRESH_TARGETS__:', '').trim();

            if (type === currentType || currentType === 'all') {
                loadTargets(type);
            }
        }

        if (msg.startsWith('__RUN_START__:')) {
            handled = true;

            const type = msg.replace('__RUN_START__:', '').trim();

            currentType = type;
            currentTargets = [];
            isRunning = true;
            isStopRequested = false;
            liveTargetCount = 0;

            clearTable(`${getTypeLabel(type)} 결과 생성중...`);
            setStatus(`${getTypeLabel(type)} 실행중...`);
        }

        if (msg.startsWith('__RUN_DONE__:')) {
            handled = true;

            const type = msg.replace('__RUN_DONE__:', '').trim();

            if (isStopRequested) {
                return;
            }

            isRunning = false;
            setStatus(`${getTypeLabel(type)} 작업 완료`);
            loadTargets(type);
        }

        if (msg.startsWith('__STOP_REQUESTED__')) {
            handled = true;
            markStopRequested('전체 작업 중지됨');
        }
    });

    return handled;
}

function getTypeLabel(type) {
    if (type === 'pokemon') return '포켓몬';
    if (type === 'onepiece') return '원피스';
    return '전체';
}

function setupAutoEditButton() {
    if (!document.querySelector('#targetTable')) return;

    let button = document.getElementById('autoEditAllBtn');

    if (!button) {
        button = document.createElement('button');
        button.id = 'autoEditAllBtn';
        button.textContent = AUTO_EDIT_LABEL;
        button.style.margin = '10px 0';
        button.style.padding = '10px 16px';
        button.style.cursor = 'pointer';
        button.style.fontWeight = '800';
        button.style.background = '#111827';
        button.style.color = '#ffffff';
        button.style.border = 'none';
        button.style.borderRadius = '8px';
        button.style.whiteSpace = 'nowrap';

        const table = document.querySelector('#targetTable');
        table.parentElement.insertBefore(button, table);
    }

    button.onclick = () => {
        autoEditAllRows();
    };
}

function setupTableHeader() {
    const table = document.querySelector('#targetTable');

    if (!table) return;

    table.style.tableLayout = 'auto';
    table.style.width = '100%';

    let thead = table.querySelector('thead');

    if (!thead) {
        thead = document.createElement('thead');
        table.prepend(thead);
    }

    thead.innerHTML = `
        <tr>
            <th>No</th>
            <th>상품명</th>
            <th>옵션</th>
            <th>내 가격</th>
            <th>최저가</th>
            <th>입력가</th>
            <th>차이</th>
            <th>수량</th>
            <th>stockId</th>
            <th style="width:110px; min-width:110px; text-align:center;">수정</th>
            <th style="width:100px; min-width:100px; text-align:center;">상태</th>
        </tr>
    `;

    setupAutoEditButton();
}

function clearTable(message) {
    setupTableHeader();

    const tbody = document.querySelector('#targetTable tbody');

    if (!tbody) return;

    tbody.innerHTML = `
        <tr>
            <td colspan="11" style="text-align:center; padding:24px;">
                ${message}
            </td>
        </tr>
    `;
}

function renderTargets(items) {
    setupTableHeader();

    const tbody = document.querySelector('#targetTable tbody');

    if (!tbody) return;

    tbody.innerHTML = '';

    if (!Array.isArray(items) || items.length === 0) {
        clearTable('수정 대상 없음');
        return;
    }

    items.forEach((item, index) => {
        appendTargetRow(item, index + 1);
    });
}

function renderItems(items) {
    renderTargets(items);
}

function appendTargetRow(item, no) {
    const tbody = document.querySelector('#targetTable tbody');

    if (!tbody) return;

    const emptyRow = tbody.querySelector('td[colspan="11"]');

    if (emptyRow) {
        tbody.innerHTML = '';
    }

    const myPrice = parsePrice(item.myPrice);
    const lowestPrice = parsePrice(item.lowestPrice);
    const newPrice = parsePrice(item.targetPrice);
    const qty = parsePrice(item.qty);
    const diff = myPrice - newPrice;

    const tr = document.createElement('tr');

    tr.dataset.stockId = item.stockId || '';
    tr.dataset.lowestPrice = String(lowestPrice || 0);
    tr.dataset.newPrice = String(newPrice || 0);

    let diffText = diff.toLocaleString();

    if (diff > 0) {
        diffText = `+${diff.toLocaleString()}`;
    }

    tr.innerHTML = `
        <td>${no}</td>
        <td>${item.koreanName || ''}</td>
        <td>${item.option || ''}</td>
        <td>${formatPrice(myPrice)}</td>
        <td>${formatPrice(lowestPrice)}</td>
        <td style="font-weight:800;color:#2563eb;">${formatPrice(newPrice)}</td>
        <td>${diffText}</td>
        <td>${formatPrice(qty)}</td>
        <td>${item.stockId || ''}</td>
        <td style="width:110px; min-width:110px; text-align:center;">
            <button class="edit-stock-btn" data-stock-id="${item.stockId || ''}" style="width:82px;height:34px;background:#2563eb;color:#ffffff;border:none;border-radius:7px;font-weight:800;cursor:pointer;white-space:nowrap;word-break:keep-all;line-height:34px;padding:0;">수정</button>
        </td>
        <td class="edit-status" style="width:100px;min-width:100px;text-align:center;font-weight:800;color:#6b7280;white-space:nowrap;word-break:keep-all;">대기</td>
    `;

    const editButton = tr.querySelector('.edit-stock-btn');

    editButton.addEventListener('click', event => {
        event.stopPropagation();
        openStockEdit(item.stockId, newPrice, tr, { fromAuto: false });
    });

    tbody.appendChild(tr);
}

function updateRowStatus(row, text, color) {
    if (!row) return;

    const statusCell = row.querySelector('.edit-status');

    if (!statusCell) return;

    statusCell.textContent = text;
    statusCell.style.fontWeight = '800';
    statusCell.style.whiteSpace = 'nowrap';
    statusCell.style.wordBreak = 'keep-all';

    if (text === '대기') {
        statusCell.style.color = '#6b7280';
    } else if (text === '수정중...') {
        statusCell.style.color = '#f59e0b';
    } else if (text === '수정완료') {
        statusCell.style.color = '#16a34a';
    } else if (text === '실패' || text === '중지됨' || text === '연결끊김') {
        statusCell.style.color = '#dc2626';
    } else {
        statusCell.style.color = color || '#6b7280';
    }
}

function setRowStatus(row, text, color) {
    updateRowStatus(row, text, color);
}

function setRowButton(row, disabled, text) {
    if (!row) return;

    const button = row.querySelector('.edit-stock-btn');

    if (!button) return;

    button.disabled = disabled;
    button.textContent = text || button.textContent;
    button.style.whiteSpace = 'nowrap';
    button.style.wordBreak = 'keep-all';

    if (text === '수정중') {
        button.style.background = '#f59e0b';
    } else if (text === '완료') {
        button.style.background = '#16a34a';
    } else if (text === '재시도') {
        button.style.background = '#dc2626';
    } else {
        button.style.background = '#2563eb';
    }

    button.style.color = '#ffffff';
    button.style.opacity = disabled && text !== '완료' ? '0.65' : '1';
    button.style.cursor = disabled ? 'not-allowed' : 'pointer';
}

function addLiveTarget(item) {
    if (isStopRequested) {
        return;
    }

    currentTargets = mergeTargets(currentTargets, [item]);
    liveTargetCount = currentTargets.length;

    renderTargets(currentTargets);
    setStatus(`${getTypeLabel(currentType)} 실행중... 수정대상 ${liveTargetCount}개 발견`);
}

async function loadTargets(type = currentType) {
    currentType = type;

    try {
        const res = await fetch(`/api/targets?type=${type}&t=${Date.now()}`);
        const data = await res.json();

        if (isStopRequested) {
            return;
        }

        if (!data.success) {
            appendLog(`[수정대상 새로고침 실패] ${data.message || 'success=false'}`);
            setStatus('연결 일시 오류 / 재시도 가능');
            return;
        }

        const incomingTargets = getResponseTargets(data);

        if (!Array.isArray(incomingTargets)) {
            appendLog('[수정대상 새로고침 보류] 응답 데이터가 배열이 아님');
            setStatus('연결 일시 오류 / 재시도 가능');
            return;
        }

        currentTargets = mergeTargets(currentTargets, incomingTargets);
        liveTargetCount = currentTargets.length;

        if (isAutoEditing) {
            appendLog(`[수정대상 새로고침 보류] 자동수정 중이어서 현재 행 유지 / ${liveTargetCount}개`);
            return;
        }

        renderTargets(currentTargets);

        if (!isRunning) {
            setStatus(`${getTypeLabel(type)} 수정대상 ${liveTargetCount}개`);
        }
    } catch (err) {
        if (isStopRequested || isStopLikeError(err.message)) {
            return;
        }

        appendLog(`[수정대상 새로고침 실패] ${err.message}`);
        setStatus('연결 일시 오류 / 재시도 가능');
    }
}

async function openStockEdit(stockId, newPrice, row, options = {}) {
    const fromAuto = options.fromAuto === true;

    if (isStopRequested) {
        return null;
    }

    if (!stockId) {
        updateRowStatus(row, '실패');
        reportSoftError('stockId 없음', '수정 실패');
        return false;
    }

    const targetPrice = parsePrice(newPrice || row?.dataset?.newPrice);

    if (!targetPrice || targetPrice <= 0) {
        updateRowStatus(row, '실패');
        reportSoftError('입력가 없음', '수정 실패');
        return false;
    }

    if (row) {
        row.style.opacity = '0.55';
    }

    updateRowStatus(row, '수정중...');
    setRowButton(row, true, '수정중');
    setStatus(`자동수정 중... stockId=${stockId}, 입력가=${formatPrice(targetPrice)}`);

    try {
        const res = await fetch(
            `/api/open-stock-edit?stockId=${encodeURIComponent(stockId)}&newPrice=${encodeURIComponent(targetPrice)}&t=${Date.now()}`
        );

        const data = await res.json();

        if (isStopRequested || data.stopped) {
            markStopRequested('전체 작업 중지됨');
            updateRowStatus(row, '중지됨');
            setRowButton(row, false, '수정');
            return null;
        }

        if (!data.success) {
            throw new Error(data.message || '재고 수정 실패');
        }

        updateRowStatus(row, '수정완료');
        setRowButton(row, true, '완료');
        setStatus(`수정완료: stockId=${stockId}, 입력가=${formatPrice(targetPrice)}`);

        return true;

    } catch (err) {
        const message = err.message || String(err);

        if (isStopRequested || isStopLikeError(message)) {
            markStopRequested('전체 작업 중지됨');
            updateRowStatus(row, '중지됨');
            setRowButton(row, false, '수정');
            return null;
        }

        if (isFetchFailure(message)) {
            updateRowStatus(row, '연결끊김');
            setRowButton(row, false, '재시도');
            appendLog(`[서버 연결 실패] stockId=${stockId}: ${message}`);
            setStatus('연결 일시 오류 / 재시도 가능');
            return fromAuto ? null : false;
        }

        updateRowStatus(row, '실패');
        setRowButton(row, false, '재시도');
        reportSoftError(`stockId=${stockId}: ${message}`, '수정 실패');
        return false;

    } finally {
        if (row) {
            row.style.opacity = '1';
        }
    }
}

async function autoEditAllRows() {
    if (isAutoEditing) {
        reportSoftError('이미 전체 자동수정 실행중', '전체 자동수정 실행중');
        return;
    }

    resetStopState();

    const rows = Array.from(document.querySelectorAll('#targetTable tbody tr'))
        .filter(row => row.dataset.stockId);

    if (rows.length === 0) {
        reportSoftError('수정할 상품 없음', '수정할 상품 없음');
        return;
    }

    isAutoEditing = true;

    const autoButton = document.getElementById('autoEditAllBtn');

    if (autoButton) {
        autoButton.disabled = true;
        autoButton.textContent = '전체 자동수정 중...';
        autoButton.style.opacity = '0.65';
        autoButton.style.cursor = 'not-allowed';
    }

    let successCount = 0;
    let failCount = 0;
    let stoppedByConnection = false;

    for (let i = 0; i < rows.length; i++) {
        if (isStopRequested) {
            break;
        }

        const row = rows[i];
        const stockId = row.dataset.stockId;
        const newPrice = parsePrice(row.dataset.newPrice);

        setStatus(`전체 자동수정 중... ${i + 1}/${rows.length} stockId=${stockId}, 입력가=${formatPrice(newPrice)}`);

        const result = await openStockEdit(stockId, newPrice, row, { fromAuto: true });

        if (isStopRequested) {
            break;
        }

        if (result === null) {
            if (row?.querySelector('.edit-status')?.textContent === '연결끊김') {
                stoppedByConnection = true;
                failCount += 1;
            }
            break;
        }

        if (result === true) {
            successCount += 1;
        } else {
            failCount += 1;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    isAutoEditing = false;
    setAutoEditButtonReady();

    if (isStopRequested) {
        setStatus(`전체 자동수정 중지됨 / 성공 ${successCount}개 / 실패 ${failCount}개`);
        return;
    }

    if (stoppedByConnection) {
        setStatus(`연결 일시 오류 / 재시도 가능 / 성공 ${successCount}개 / 실패 ${failCount}개`);
        appendLog(`[전체 자동수정 중단] 서버 연결 실패 / 성공 ${successCount}개 / 실패 ${failCount}개`);
        return;
    }

    setStatus(`전체 자동수정 완료 / 성공 ${successCount}개 / 실패 ${failCount}개`);
    appendLog(`[전체 자동수정 완료] 성공 ${successCount}개 / 실패 ${failCount}개`);
}

function runAndRefresh(type, url, label) {
    resetStopState();

    currentType = type;
    currentTargets = [];
    liveTargetCount = 0;
    isRunning = true;

    setStatus(`${label} 실행중...`);

    if (logBox) {
        logBox.textContent = '';
    }

    clearTable(`${label} 결과 생성중...`);

    fetch(url)
        .then(res => res.json())
        .then(async data => {
            isRunning = false;

            if (isStopRequested || data.stopped) {
                markStopRequested('전체 작업 중지됨');
                return;
            }

            if (!data.success) {
                if (isStopLikeError(data.message)) {
                    markStopRequested('전체 작업 중지됨');
                    return;
                }

                setStatus('실패');
                appendLog(`[실행 실패] ${data.message}`);
                return;
            }

            await loadTargets(type);
            setStatus(`${label} 작업 완료 / 수정대상 ${liveTargetCount}개`);
        })
        .catch(err => {
            isRunning = false;

            if (isStopRequested || isStopLikeError(err.message)) {
                markStopRequested('전체 작업 중지됨');
                return;
            }

            setStatus('연결 일시 오류 / 재시도 가능');
            appendLog(`[실행 오류] ${err.message}`);
        });
}

if (stopBtn) {
    setStopButtonReady();

    stopBtn.addEventListener('click', async () => {
        const ok = confirm('현재 실행중인 모든 작업을 중지할까요?');

        if (!ok) {
            return;
        }

        isStopRequested = true;

        stopBtn.disabled = true;
        stopBtn.textContent = STOP_BUTTON_LABEL;
        stopBtn.style.opacity = '0.6';
        stopBtn.style.cursor = 'not-allowed';

        setStatus('전체 작업 중지 요청중...');

        try {
            const res = await fetch(`/api/stop?t=${Date.now()}`);
            const data = await res.json();

            if (!data.success && !data.stopped) {
                throw new Error(data.message || '중지 실패');
            }

            markStopRequested('전체 작업 중지 요청 완료');
            appendLog('[전체 작업 중지 요청 완료]');

        } catch (err) {
            if (!isStopLikeError(err.message)) {
                appendLog(`[중지 요청 오류] ${err.message}`);
            }

        } finally {
            setStopButtonReady();
        }
    });
}

if (pokemonBtn) {
    pokemonBtn.addEventListener('click', () => {
        runAndRefresh('pokemon', '/run/pokemon', '포켓몬');
    });
}

if (onepieceBtn) {
    onepieceBtn.addEventListener('click', () => {
        runAndRefresh('onepiece', '/run/onepiece', '원피스');
    });
}

if (allBtn) {
    allBtn.addEventListener('click', () => {
        runAndRefresh('pokemon', '/run/all', '전체');
    });
}

setupTableHeader();

if (document.querySelector('#targetTable')) {
    clearTable('실행 버튼을 눌러주세요');
}
