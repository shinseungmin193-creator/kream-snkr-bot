const pokemonBtn = document.getElementById('pokemonBtn');
const onepieceBtn = document.getElementById('onepieceBtn');
const allBtn = document.getElementById('allBtn');
const stopBtn = document.getElementById('stopBtn');

const statusBox = document.getElementById('status');
const logBox = document.getElementById('log');

let currentType = 'all';
let liveTargetCount = 0;
let isRunning = false;
let isAutoEditing = false;
let isStopRequested = false;

let eventSource = null;

function connectLog() {
    eventSource = new EventSource('/logs');

    eventSource.onopen = () => {
        if (logBox) {
            logBox.textContent += '[웹 로그 연결됨]\n';
            logBox.scrollTop = logBox.scrollHeight;
        }
    };

    eventSource.onmessage = event => {
        const text = event.data.replace(/\\n/g, '\n');

        const isSpecial = handleSpecialMessage(text);

        if (isSpecial) {
            return;
        }

        if (logBox) {
            logBox.textContent += text + '\n';
            logBox.scrollTop = logBox.scrollHeight;
        }
    };

    eventSource.onerror = () => {
        if (logBox) {
            logBox.textContent += '[웹 로그 연결 에러]\n';
            logBox.scrollTop = logBox.scrollHeight;
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
                console.error('TARGET_FOUND 파싱 실패:', err);
            }
        }

        if (msg.startsWith('__REFRESH_TARGETS__:')) {
            handled = true;

            const type = msg.replace('__REFRESH_TARGETS__:', '').trim();

            if (type === currentType || currentType === 'all') {
                loadTargets(type);
            }
        }

        if (msg.startsWith('__RUN_START__:')) {
            handled = true;

            const type = msg.replace('__RUN_START__:', '').trim();

            currentType = type;
            isRunning = true;
            liveTargetCount = 0;

            clearTable(`${getTypeLabel(type)} 새 결과 생성중...`);

            if (statusBox) {
                statusBox.textContent = `${getTypeLabel(type)} 실행중...`;
            }
        }

        if (msg.startsWith('__RUN_DONE__:')) {
            handled = true;

            const type = msg.replace('__RUN_DONE__:', '').trim();

            isRunning = false;

            if (statusBox) {
                statusBox.textContent = `${getTypeLabel(type)} 작업 완료`;
            }

            loadTargets(type);
        }

        if (msg.startsWith('__STOP_REQUESTED__')) {
            handled = true;

            isRunning = false;
            isAutoEditing = false;
            isStopRequested = true;

            const autoButton = document.getElementById('autoEditAllBtn');

            if (autoButton) {
                autoButton.disabled = false;
                autoButton.textContent = '전체 자동수정';
                autoButton.style.opacity = '1';
                autoButton.style.cursor = 'pointer';
            }

            if (stopBtn) {
                stopBtn.disabled = false;
                stopBtn.textContent = '🛑 전체 작업 중지';
                stopBtn.style.opacity = '1';
                stopBtn.style.cursor = 'pointer';
            }

            if (statusBox) {
                statusBox.textContent = '전체 작업 중지됨';
            }
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
        button.textContent = '전체 자동수정';
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

function renderItems(items) {
    setupTableHeader();

    const tbody = document.querySelector('#targetTable tbody');

    if (!tbody) return;

    tbody.innerHTML = '';

    if (!items || items.length === 0) {
        clearTable('수정대상 없음');
        return;
    }

    items.forEach((item, index) => {
        appendTargetRow(item, index + 1);
    });
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
        openStockEdit(item.stockId, newPrice, tr);
    });

    tbody.appendChild(tr);
}

function setRowStatus(row, text, color) {
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
    } else if (text === '실패') {
        statusCell.style.color = '#dc2626';
    } else {
        statusCell.style.color = color || '#6b7280';
    }
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
    } else if (text === '재수정') {
        button.style.background = '#dc2626';
    } else {
        button.style.background = '#2563eb';
    }

    button.style.color = '#ffffff';
    button.style.opacity = disabled && text !== '완료' ? '0.65' : '1';
    button.style.cursor = disabled ? 'not-allowed' : 'pointer';
}

function addLiveTarget(item) {
    setupTableHeader();

    liveTargetCount += 1;
    appendTargetRow(item, liveTargetCount);

    if (statusBox) {
        statusBox.textContent = `${getTypeLabel(currentType)} 실행중... 수정대상 ${liveTargetCount}개 발견`;
    }
}

async function loadTargets(type = currentType) {
    currentType = type;
    liveTargetCount = 0;

    const res = await fetch(`/api/targets?type=${type}&t=${Date.now()}`);
    const data = await res.json();

    if (!data.success) {
        clearTable('수정대상 불러오기 실패');
        return;
    }

    renderItems(data.items);
    liveTargetCount = data.items ? data.items.length : 0;

    if (!isRunning && statusBox) {
        statusBox.textContent = `${getTypeLabel(type)} 수정대상 ${liveTargetCount}개`;
    }
}

async function openStockEdit(stockId, newPrice, row) {
    if (isStopRequested) {
        return false;
    }

    if (!stockId) {
        alert('stockId 없음');
        return false;
    }

    const targetPrice = parsePrice(newPrice || row?.dataset?.newPrice);

    if (!targetPrice || targetPrice <= 0) {
        alert('입력가 없음');
        return false;
    }

    if (row) {
        row.style.opacity = '0.55';
    }

    setRowStatus(row, '수정중...');
    setRowButton(row, true, '수정중');

    if (statusBox) {
        statusBox.textContent = `자동수정 중... stockId=${stockId}, 입력가=${formatPrice(targetPrice)}`;
    }

    try {
        const res = await fetch(
            `/api/open-stock-edit?stockId=${encodeURIComponent(stockId)}&newPrice=${encodeURIComponent(targetPrice)}&t=${Date.now()}`
        );

        const data = await res.json();

        if (!data.success) {
            throw new Error(data.message || '재고 수정 실패');
        }

        setRowStatus(row, '수정완료');
        setRowButton(row, true, '완료');

        if (statusBox) {
            statusBox.textContent = `수정완료: stockId=${stockId}, 입력가=${formatPrice(targetPrice)}`;
        }

        return true;

    } catch (err) {
        if (isStopRequested) {
            setRowStatus(row, '중지됨', '#dc2626');
            setRowButton(row, false, '재수정');
            return false;
        }

        setRowStatus(row, '실패');
        setRowButton(row, false, '재수정');

        if (statusBox) {
            statusBox.textContent = `수정 실패: stockId=${stockId}`;
        }

        alert(err.message);
        return false;

    } finally {
        if (row) {
            row.style.opacity = '1';
        }
    }
}

async function autoEditAllRows() {
    if (isAutoEditing) {
        alert('이미 전체 자동수정 실행중');
        return;
    }

    isStopRequested = false;

    const rows = Array.from(document.querySelectorAll('#targetTable tbody tr'))
        .filter(row => row.dataset.stockId);

    if (rows.length === 0) {
        alert('수정할 상품 없음');
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

    for (let i = 0; i < rows.length; i++) {
        if (isStopRequested) {
            break;
        }

        const row = rows[i];
        const stockId = row.dataset.stockId;
        const newPrice = parsePrice(row.dataset.newPrice);

        if (statusBox) {
            statusBox.textContent = `전체 자동수정 중... ${i + 1}/${rows.length} stockId=${stockId}, 입력가=${formatPrice(newPrice)}`;
        }

        const ok = await openStockEdit(stockId, newPrice, row);

        if (ok) {
            successCount += 1;
        } else {
            failCount += 1;
        }

        if (isStopRequested) {
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    isAutoEditing = false;

    if (autoButton) {
        autoButton.disabled = false;
        autoButton.textContent = '전체 자동수정';
        autoButton.style.opacity = '1';
        autoButton.style.cursor = 'pointer';
    }

    if (isStopRequested) {
        if (statusBox) {
            statusBox.textContent = `전체 자동수정 중지됨 / 성공 ${successCount}개 / 실패 ${failCount}개`;
        }

        alert(`전체 자동수정 중지됨\n성공: ${successCount}개\n실패: ${failCount}개`);
        return;
    }

    if (statusBox) {
        statusBox.textContent = `전체 자동수정 완료 / 성공 ${successCount}개 / 실패 ${failCount}개`;
    }

    alert(`전체 자동수정 완료\n성공: ${successCount}개\n실패: ${failCount}개`);
}

function runAndRefresh(type, url, label) {
    isStopRequested = false;
    currentType = type;
    liveTargetCount = 0;
    isRunning = true;

    if (statusBox) {
        statusBox.textContent = `${label} 실행중...`;
    }

    if (logBox) {
        logBox.textContent = '';
    }

    clearTable(`${label} 새 결과 생성중...`);

    fetch(url)
        .then(res => res.json())
        .then(async data => {
            isRunning = false;

            if (!data.success) {
                if (statusBox) {
                    statusBox.textContent = '실패';
                }

                clearTable(`${label} 실행 실패`);
                alert('실패: ' + data.message);
                return;
            }

            await loadTargets(type);

            if (statusBox) {
                statusBox.textContent = `${label} 작업 완료 / 수정대상 ${liveTargetCount}개`;
            }
        })
        .catch(err => {
            isRunning = false;

            if (statusBox) {
                statusBox.textContent = '에러 발생';
            }

            clearTable(`${label} 실행 에러`);
            alert(err.message);
        });
}

if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
        const ok = confirm('현재 실행중인 모든 작업을 중지할까요?');

        if (!ok) {
            return;
        }

        isStopRequested = true;

        stopBtn.disabled = true;
        stopBtn.textContent = '🛑 중지 요청중...';
        stopBtn.style.opacity = '0.6';
        stopBtn.style.cursor = 'not-allowed';

        if (statusBox) {
            statusBox.textContent = '전체 작업 중지 요청중...';
        }

        try {
            const res = await fetch(`/api/stop?t=${Date.now()}`);
            const data = await res.json();

            if (!data.success) {
                throw new Error(data.message || '중지 실패');
            }

            isRunning = false;
            isAutoEditing = false;

            if (statusBox) {
                statusBox.textContent = '전체 작업 중지 요청 완료';
            }

            if (logBox) {
                logBox.textContent += '\n[전체 작업 중지 요청 완료]\n';
                logBox.scrollTop = logBox.scrollHeight;
            }

        } catch (err) {
            alert(err.message);

        } finally {
            stopBtn.disabled = false;
            stopBtn.textContent = '🛑 전체 작업 중지';
            stopBtn.style.opacity = '1';
            stopBtn.style.cursor = 'pointer';
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
    clearTable('실행 버튼을 눌러주세요.');
}