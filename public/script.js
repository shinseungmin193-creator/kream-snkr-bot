const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = {
  page: 1, pageSize: 10, pages: 1, inventory: [], targets: [], busy: false, stopped: false,
  selected: new Set(), dirtyFloors: new Map(),
  queue: { current:null, waiting:[], recent:[] }, queueLoaded:false, knownRecent:new Set(), stopInFlight:false,
  completedFlash:null, completedFlashTimer:null
};
const labels = { NEEDS_UPDATE:'수정 필요', FLOOR_REACHED:'하한가 도달', LOWEST:'최저가 유지', NO_FLOOR:'하한가 미설정', SOLD_OUT:'판매 종료', ON_SALE:'판매중', NOT_COMPARED:'비교 전', COMPLETED:'완료', FAILED:'실패', WAITING:'대기' };
const money = value => Number(value || 0).toLocaleString('ko-KR');
const time = value => value ? new Date(value).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '-';
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));

function log(text, error = false) {
  const box = $('#log');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString('ko-KR', { hour12:false })}  ${text}`;
  if (error) line.style.color = '#ff6868';
  box.append(line);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
function status(text) { $('#status').textContent = text; }
function setBusy(value, name = '') {
  state.busy = value;
  if (name) status(name);
  updateFloorControls();
  updateQueueButtons();
}
async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || data.success === false) throw new Error(data.message || `서버 오류 (${response.status})`);
  return data;
}

async function queuePost(url, payload = {}) {
  return jsonFetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
}
function formatQueueDuration(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return minutes ? `${minutes}분 ${rest}초` : `${rest}초`;
}
function queueTime(value) {
  return value ? new Date(value).toLocaleTimeString('ko-KR', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '-';
}
function decodeQueueState(encoded) {
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function updateQueueButtons() {
  const activeTypes = new Set([
    state.queue.current?.type,
    ...state.queue.waiting.map(job => job.type)
  ].filter(Boolean));
  $$('[data-action="sync"]').forEach(button => button.disabled = activeTypes.has('inventory-sync'));
  $$('[data-action="compare"],#compareSelectedBtn').forEach(button => button.disabled = activeTypes.has('price-compare-selected'));
  $$('[data-action="auto"]').forEach(button => button.disabled = activeTypes.has('price-update'));
  $$('[data-legacy]').forEach(button => button.disabled = activeTypes.has(`legacy-${button.dataset.legacy}`));
  const stopButton = $('[data-action="stop"]');
  if (stopButton) stopButton.disabled = state.stopInFlight || (!state.queue.current && state.queue.waiting.length === 0);
  const currentStopButton = $('#cancelCurrentQueue');
  if (currentStopButton) currentStopButton.disabled = state.stopInFlight;
  updateFloorControls();
}
function renderQueue() {
  const current = state.queue.current || state.completedFlash;
  const liveCurrent = state.queue.current;
  const progress = current?.progress || { current:0, total:null, percent:0, etaSeconds:null, currentStep:null, recentMessages:[] };
  const totalKnown = Number(progress.total) > 0;
  $('#queueCurrentName').textContent = current?.label || '실행 중인 작업 없음';
  $('#queueProgressBar').style.width = `${progress.percent || 0}%`;
  $('#queuePercent').textContent = `${progress.percent || 0}%`;
  $('#queueCount').textContent = current
    ? (totalKnown ? `${progress.current || 0} / ${progress.total}` : ((progress.current || 0) > 0 ? `${progress.current}개 처리 · 대상 계산 중` : '대상 계산 중'))
    : '0 / 0';
  $('#queueCurrentStep').textContent = current?.progress?.currentStep || '-';
  $('#queueProgressMessage').textContent = current?.progress?.message || '-';
  $('#queueEta').textContent = current
    ? (progress.etaSeconds !== null && progress.etaSeconds !== undefined ? formatQueueDuration(progress.etaSeconds) : (totalKnown && (progress.current || 0) === 0 ? '계산 중' : '-'))
    : '-';
  const recentProgress = (progress.recentMessages || []).filter(message => message && message !== progress.message).slice(-4);
  $('#queueProgressHistory').innerHTML = recentProgress.map(message => `<span>· ${escapeHtml(message)}</span>`).join('');
  $('#cancelCurrentQueue').hidden = !liveCurrent;
  $('#queueWaitingCount').textContent = state.queue.waiting.length;
  $('#queueWaiting').innerHTML = state.queue.waiting.length ? state.queue.waiting.map((job, index) => `
    <div class="queue-item"><span class="order">${index + 1}</span><div class="job-main"><strong>${escapeHtml(job.label)}</strong><span>등록 ${queueTime(job.registeredAt)}</span></div><button data-queue-cancel="${escapeHtml(job.id)}">취소</button></div>`).join('') : '<p>대기 중인 작업이 없습니다.</p>';
  $('#queueRecentCount').textContent = state.queue.recent.length;
  $('#queueRecent').innerHTML = state.queue.recent.length ? state.queue.recent.map(job => {
    const statusClass = job.status === '완료' ? 'completed' : job.status === '실패' ? 'failed' : 'canceled';
    return `<div class="queue-item"><span class="queue-result ${statusClass}">${escapeHtml(job.status)}</span><div class="job-main"><strong>${escapeHtml(job.label)}</strong><span>${queueTime(job.startedAt)} → ${queueTime(job.endedAt)} · ${formatQueueDuration(job.durationSeconds)}${job.error ? ` · ${escapeHtml(job.error)}` : ''}</span></div></div>`;
  }).join('') : '<p>최근 작업이 없습니다.</p>';
  $$('[data-queue-cancel]').forEach(button => button.onclick = () => cancelQueueJob(button.dataset.queueCancel));
  updateQueueButtons();
}
function applyQueueState(queue) {
  const terminalIds = new Set((queue.recent || []).map(job => job.id));
  const newTerminal = state.queueLoaded ? (queue.recent || []).find(job => !state.knownRecent.has(job.id)) : null;
  const hasNewTerminal = Boolean(newTerminal);
  state.queue = { current:queue.current || null, waiting:queue.waiting || [], recent:queue.recent || [] };
  state.knownRecent = terminalIds;
  state.queueLoaded = true;
  if (newTerminal && !state.queue.current) {
    state.completedFlash = newTerminal;
    clearTimeout(state.completedFlashTimer);
    state.completedFlashTimer = setTimeout(() => {
      state.completedFlash = null;
      renderQueue();
    }, 1000);
  } else if (state.queue.current) {
    state.completedFlash = null;
    clearTimeout(state.completedFlashTimer);
  }
  renderQueue();
  if (hasNewTerminal) Promise.all([loadSummary(), loadInventory(), loadTargets()]);
}
async function loadQueue() {
  try { const data = await jsonFetch('/api/queue'); applyQueueState(data.queue); }
  catch (error) { log(`작업 Queue 조회 실패: ${error.message}`, true); }
}
function requestStopConfirmation() {
  return new Promise(resolve => {
    const dialog = $('#queueCancelDialog');
    dialog.returnValue = '';
    dialog.showModal();
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once:true });
  });
}
async function cancelQueueJob(jobId) {
  try {
    await jsonFetch(`/api/queue/${encodeURIComponent(jobId)}/cancel`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    log('대기 작업 취소 완료');
    await loadQueue();
  } catch (error) { log(`Queue 취소 실패: ${error.message}`, true); status(`Queue 취소 실패: ${error.message}`); }
}

const summaryCards = [['totalActive','▣','전체 판매중 재고'],['needsUpdate','⚠','수정 필요'],['floorReached','↓','하한가 도달'],['lowestMaintained','✓','최저가 유지'],['soldOut','×','판매 종료'],['updatedToday','▣','수정 완료 (오늘)']];
async function loadSummary() {
  try {
    const { summary } = await jsonFetch('/api/dashboard/summary');
    $('#summary').innerHTML = summaryCards.map(([key, icon, label]) => `<div class="metric"><i>${icon}</i><div><small>${label}</small><strong>${summary[key] || 0}<small>개</small></strong></div></div>`).join('');
    $('#lastSync').textContent = time(summary.lastSyncedAt);
    $('#syncBadge').textContent = summary.lastSyncedAt ? '성공' : '대기';
  } catch (error) { log(`요약 조회 실패: ${error.message}`, true); }
}
function inventoryQuery() {
  const query = new URLSearchParams({ page:state.page, pageSize:state.pageSize });
  if ($('#search').value) query.set('search', $('#search').value);
  if ($('#statusFilter').value) query.set('status', $('#statusFilter').value);
  if ($('#category').value) query.set('category', $('#category').value);
  return query;
}
async function loadInventory() {
  try {
    const data = await jsonFetch(`/api/inventory?${inventoryQuery()}`);
    state.inventory = data.items;
    state.pages = data.pages;
    $('#inventoryCount').textContent = `(${data.total}개)`;
    $('#pageInfo').textContent = `${data.page} / ${data.pages}`;
    renderInventory();
  } catch (error) {
    log(`판매 재고 조회 실패(기존 목록 유지): ${error.message}`, true);
    status('서버 연결 오류 · 기존 목록 유지');
  }
}

function parseFloorInput(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { valid:true, value:null };
  const digits = text.replace(/,/g, '');
  if (!/^\d+$/.test(digits)) return { valid:false, error:'숫자만 입력하세요.' };
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value <= 0) return { valid:false, error:'0보다 큰 정수를 입력하세요.' };
  if (value > 1_000_000_000) return { valid:false, error:'1,000,000,000원 이하로 입력하세요.' };
  return { valid:true, value };
}
function updateFloorControls() {
  const count = state.dirtyFloors.size;
  $('#dirtyFloorCount').textContent = count ? `(${count})` : '';
  $('#saveFloorPricesBtn').disabled = count === 0;
}
function updateSelectionUI() {
  $('#selectedCount').textContent = `선택 ${state.selected.size}개`;
  const visibleIds = state.inventory.map(item => String(item.stockId));
  const selectedVisible = visibleIds.filter(stockId => state.selected.has(stockId)).length;
  const header = $('#selectVisible');
  header.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  header.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
}
function updateFloorRow(input) {
  const stockId = input.dataset.stock;
  const row = input.closest('tr');
  const marker = row.querySelector('.floor-state');
  const dirty = state.dirtyFloors.get(stockId);
  row.classList.toggle('unsaved-row', Boolean(dirty));
  input.classList.toggle('unsaved', Boolean(dirty));
  input.classList.toggle('input-error', Boolean(dirty?.error));
  marker.textContent = dirty ? (dirty.error || '미저장') : '';
  marker.classList.toggle('error', Boolean(dirty?.error));
}
function renderInventory() {
  if (!state.inventory.length) {
    $('#inventoryBody').innerHTML = '<tr><td colspan="12" class="empty">저장된 판매 재고가 없습니다. 판매목록을 동기화해 주세요.</td></tr>';
    updateSelectionUI(); updateFloorControls(); return;
  }
  $('#inventoryBody').innerHTML = state.inventory.map((item, index) => {
    const stockId = String(item.stockId);
    const dirty = state.dirtyFloors.get(stockId);
    const floorValue = dirty ? dirty.raw : (item.floorPrice ? money(item.floorPrice) : '');
    const dirtyClass = dirty ? ' unsaved-row' : '';
    return `<tr class="${dirtyClass}" data-stock="${escapeHtml(stockId)}"><td><input class="inventory-select" type="checkbox" data-stock="${escapeHtml(stockId)}" ${state.selected.has(stockId) ? 'checked' : ''}></td><td>${(state.page-1)*state.pageSize+index+1}</td><td>${escapeHtml(item.productName || '-')}</td><td>${escapeHtml(item.optionName || '-')}</td><td>${escapeHtml(stockId)}</td><td>${money(item.currentPrice)}</td><td>${item.lowestPrice ? money(item.lowestPrice) : '-'}</td><td><div class="floor-editor"><input class="floor${dirty ? ' unsaved' : ''}${dirty?.error ? ' input-error' : ''}" inputmode="numeric" data-stock="${escapeHtml(stockId)}" value="${escapeHtml(floorValue)}" placeholder="미설정"><small class="floor-state${dirty?.error ? ' error' : ''}">${dirty ? escapeHtml(dirty.error || '미저장') : ''}</small></div></td><td>${item.targetPrice ? money(item.targetPrice) : '-'}</td><td><span class="badge ${item.compareStatus || item.saleStatus}">${labels[item.compareStatus] || labels[item.saleStatus] || item.compareStatus}</span></td><td>${money(item.remainingQuantity)}</td><td>${time(item.lastSyncedAt)}</td></tr>`;
  }).join('');

  $$('.inventory-select').forEach(input => input.onchange = () => {
    input.checked ? state.selected.add(input.dataset.stock) : state.selected.delete(input.dataset.stock);
    updateSelectionUI();
  });
  $$('.floor').forEach(input => {
    input.onfocus = () => { input.value = input.value.replace(/,/g, ''); };
    input.oninput = () => {
      const stockId = input.dataset.stock;
      const item = state.inventory.find(candidate => String(candidate.stockId) === stockId);
      const parsed = parseFloorInput(input.value);
      const original = item?.floorPrice == null ? null : Number(item.floorPrice);
      if (parsed.valid && parsed.value === original) state.dirtyFloors.delete(stockId);
      else state.dirtyFloors.set(stockId, { raw:input.value, value:parsed.value, error:parsed.valid ? null : parsed.error });
      updateFloorRow(input); updateFloorControls();
    };
    input.onblur = () => {
      const parsed = parseFloorInput(input.value);
      if (parsed.valid && parsed.value !== null) input.value = money(parsed.value);
      const dirty = state.dirtyFloors.get(input.dataset.stock);
      if (dirty) dirty.raw = input.value;
    };
  });
  updateSelectionUI(); updateFloorControls();
}

async function saveFloorPrices() {
  if (!state.dirtyFloors.size) { status('저장할 하한가 변경사항이 없습니다.'); return; }
  const invalid = [...state.dirtyFloors.entries()].filter(([, item]) => item.error);
  if (invalid.length) {
    const detail = invalid.map(([stockId, item]) => `${stockId}: ${item.error}`).join(', ');
    log(`하한가 저장 실패: ${detail}`, true); status(`하한가 입력 오류: ${invalid[0][0]}`); return;
  }
  const items = [...state.dirtyFloors.entries()].map(([stockId, item]) => ({ stockId, lowerPrice:item.value }));
  const button = $('#saveFloorPricesBtn'); button.disabled = true;
  try {
    const result = await jsonFetch('/api/inventory/lower-prices', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({items}) });
    result.items.forEach(saved => {
      const item = state.inventory.find(candidate => String(candidate.stockId) === String(saved.stockId));
      if (item) item.floorPrice = saved.floorPrice;
      state.dirtyFloors.delete(String(saved.stockId));
      const input = $(`.floor[data-stock="${CSS.escape(String(saved.stockId))}"]`);
      if (input) { input.value = saved.floorPrice == null ? '' : money(saved.floorPrice); updateFloorRow(input); }
    });
    log(`하한가 저장 완료: ${result.count}개`); status(`하한가 저장 완료: ${result.count}개`);
  } catch (error) { log(`하한가 저장 실패: ${error.message}`, true); status('하한가 저장 실패'); }
  finally { updateFloorControls(); }
}

async function loadTargets() {
  try {
    const data = await jsonFetch('/api/inventory/targets');
    if (!Array.isArray(data.items)) throw new Error('수정 대상 응답 형식이 올바르지 않습니다.');
    state.targets = data.items;
    renderTargets();
    return state.targets;
  } catch (error) { log(`수정 대상 조회 실패(기존 목록 유지): ${error.message}`, true); return null; }
}
function renderTargets() {
  $('#targetCount').textContent = `(${state.targets.length}개)`;
  $('#targetBody').innerHTML = state.targets.length ? state.targets.map((item,index) => `<tr data-stock="${escapeHtml(item.stockId)}" data-price="${item.targetPrice}"><td>${index+1}</td><td>${escapeHtml(item.productName)}</td><td>${escapeHtml(item.optionName)}</td><td>${money(item.targetPrice)}</td><td>${escapeHtml(item.stockId)}</td><td class="row-status"><span class="badge ${item.updateStatus}">${labels[item.updateStatus] || '대기'}</span></td></tr>`).join('') : '<tr><td colspan="6" class="empty">수정 대상이 없습니다.</td></tr>';
  $$('#targetBody tr[data-stock]').forEach(row => row.onclick = () => editOne(row));
}
async function editOne(row) {
  try {
    const result = await queuePost('/api/inventory/update-prices', { items:[{ stockId:row.dataset.stock, newPrice:Number(row.dataset.price) }] });
    row.querySelector('.row-status').innerHTML='<span class="badge WAITING">대기중</span>';
    log(`Queue 등록: 판매가 수정 · stockId=${row.dataset.stock}`);
    status(`판매가 수정 대기열 등록: ${result.job.id.slice(0, 8)}`);
    await loadQueue();
  } catch (error) { row.querySelector('.row-status').innerHTML='<span class="badge FAILED">실패</span>'; log(`수정 등록 실패: ${error.message}`, true); }
}
async function autoEdit() {
  try {
    const refreshedTargets = await loadTargets();
    if (!refreshedTargets) { status('최신 수정 대상을 불러오지 못했습니다.'); return; }
    if (!state.targets.length) { status('수정 대상이 없습니다.'); return; }
    const count = state.targets.length;
    const result = await queuePost('/api/inventory/update-prices', { allTargets:true });
    log(`Queue 등록: 전체 자동수정 ${count}개 (DB 최신 대상)`);
    status(`전체 자동수정 대기열 등록: ${result.job.id.slice(0, 8)}`);
    await loadQueue();
  } catch (error) { log(`전체 자동수정 등록 실패: ${error.message}`, true); status(`전체 자동수정 등록 실패: ${error.message}`); }
}

async function compareSelected() {
  const stockIds = [...state.selected];
  if (!stockIds.length) { status('가격 비교할 재고를 선택하세요.'); log('가격 비교할 재고를 선택하세요.'); return; }
  try {
    const result = await queuePost('/api/compare-selected', { stockIds });
    log(`Queue 등록: 선택 재고 ${stockIds.length}개 가격 비교`);
    status(`선택 가격 비교 대기열 등록: ${result.job.id.slice(0, 8)}`);
    await loadQueue();
  } catch (error) { log(`선택 가격 비교 등록 실패: ${error.message}`, true); status(`선택 가격 비교 등록 실패: ${error.message}`); }
}
async function runTask(url,label) {
  try {
    const result = await queuePost(url);
    log(`Queue 등록: ${label}`);
    status(`${label} 대기열 등록: ${result.job.id.slice(0, 8)}`);
    await loadQueue();
  } catch (error) { log(`${label} 등록 실패: ${error.message}`,true); status(`${label} 등록 실패: ${error.message}`); }
}
async function stop() {
  if (!state.queue.current && state.queue.waiting.length === 0) { status('중지할 작업이 없습니다.'); return; }
  if (!await requestStopConfirmation()) return;
  state.stopInFlight = true;
  updateQueueButtons();
  status('작업 중지 처리 중...');
  try {
    const result = await jsonFetch('/api/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    if (result.queue) applyQueueState(result.queue);
    status('작업 중지 완료');
  } catch (error) {
    log(`작업 중지 실패: ${error.message}`, true);
    status(`작업 중지 실패: ${error.message}`);
  } finally {
    state.stopInFlight = false;
    updateQueueButtons();
    await loadQueue();
  }
}
async function runLegacy(button) {
  const label=button.textContent.trim();
  try {
    const result = await jsonFetch(`/run/${button.dataset.legacy}`);
    log(`Queue 등록: ${label}`); status(`${label} 대기열 등록: ${result.job.id.slice(0, 8)}`); await loadQueue();
  } catch(error) { log(`${label} 등록 실패: ${error.message}`,true); status(`${label} 등록 실패: ${error.message}`); }
}

$$('[data-action]').forEach(button => button.onclick = () => ({ sync:()=>runTask('/api/inventory/sync','판매목록 동기화'), compare:compareSelected, auto:autoEdit, stop }[button.dataset.action]()));
$$('[data-legacy]').forEach(button => button.onclick = () => runLegacy(button));
$('#compareSelectedBtn').onclick = compareSelected;
$('#cancelCurrentQueue').onclick = stop;
$('#saveFloorPricesBtn').onclick = saveFloorPrices;
$('#clearSelectionBtn').onclick = () => { state.selected.clear(); $$('.inventory-select').forEach(input => input.checked=false); updateSelectionUI(); };
$('#selectVisible').onchange = event => { state.inventory.forEach(item => event.target.checked ? state.selected.add(String(item.stockId)) : state.selected.delete(String(item.stockId))); renderInventory(); };
$('#refreshBtn').onclick = () => Promise.all([loadInventory(),loadSummary()]);
$('#targetRefresh').onclick = loadTargets;
$('#clearLog').onclick = () => $('#log').textContent='';

const sidebar = $('#sidebar');
const sidebarBackdrop = $('#sidebarBackdrop');
const menuButton = $('#menuBtn');

function setSidebarOpen(open) {
  const visible = Boolean(open);
  sidebar.classList.toggle('open', visible);
  sidebarBackdrop.classList.toggle('open', visible);
  sidebar.setAttribute('aria-hidden', String(!visible));
  sidebarBackdrop.setAttribute('aria-hidden', String(!visible));
  sidebar.inert = !visible;
  menuButton.setAttribute('aria-expanded', String(visible));
  menuButton.setAttribute('aria-label', visible ? '사이드바 닫기' : '사이드바 열기');
}

function closeSidebar() { setSidebarOpen(false); }

menuButton.onclick = () => setSidebarOpen(!sidebar.classList.contains('open'));
sidebarBackdrop.onclick = closeSidebar;
sidebar.addEventListener('click', event => { if (event.target.closest('a')) closeSidebar(); });
document.addEventListener('click', event => {
  if (!sidebar.classList.contains('open')) return;
  if (sidebar.contains(event.target) || menuButton.contains(event.target)) return;
  closeSidebar();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !sidebar.classList.contains('open')) return;
  closeSidebar();
  menuButton.focus();
});
window.addEventListener('hashchange', closeSidebar);
setSidebarOpen(false);
let timer;
$('#search').oninput = () => { clearTimeout(timer); timer=setTimeout(()=>{state.page=1;loadInventory();},300); };
$('#statusFilter').onchange = $('#category').onchange = () => { state.page=1;loadInventory(); };
$('#resetFilters').onclick = () => { $('#search').value=$('#statusFilter').value=$('#category').value=''; state.page=1;loadInventory(); };
$('#pageSize').onchange = event => { state.pageSize=Number(event.target.value);state.page=1;loadInventory(); };
$('#prevPage').onclick = () => { if(state.page>1){state.page--;loadInventory();} };
$('#nextPage').onclick = () => { if(state.page<state.pages){state.page++;loadInventory();} };
function handleSpecialEvent(text) {
  if (text.startsWith('__QUEUE_STATE_B64__:')) {
    try { applyQueueState(decodeQueueState(text.slice('__QUEUE_STATE_B64__:'.length))); }
    catch (error) { log(`Queue 실시간 상태 해석 실패: ${error.message}`, true); }
    return true;
  }
  if (text === '__INVENTORY_REFRESH__') { Promise.all([loadSummary(), loadInventory()]); return true; }
  if (text === '__TARGETS_REFRESH__') { Promise.all([loadSummary(), loadInventory(), loadTargets()]); return true; }
  if (text.startsWith('__REFRESH_TARGETS__:')) { Promise.all([loadSummary(), loadInventory(), loadTargets()]); return true; }
  return text.startsWith('__');
}
function connectLogs() {
  const source=new EventSource('/logs');
  source.onopen=()=>log('실시간 로그 연결됨');
  source.onmessage=event=>{
    const text=event.data.replace(/\\n/g,'\n');
    if (handleSpecialEvent(text)) return;
    text.split('\n').forEach(line=>log(line));
  };
  source.onerror=()=>{source.close();setTimeout(connectLogs,2000);};
}
connectLogs(); updateFloorControls(); updateSelectionUI(); Promise.all([loadSummary(),loadInventory(),loadTargets(),loadQueue()]);
setInterval(loadQueue, 5000);
