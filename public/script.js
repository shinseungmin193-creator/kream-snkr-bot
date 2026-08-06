const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = {
  page: 1, pageSize: 10, pages: 1, inventory: [], targets: [], busy: false, stopped: false,
  selected: new Set(), dirtyFloors: new Map()
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
  $$('[data-action],[data-legacy],#compareSelectedBtn').forEach(button => {
    button.disabled = value && button.dataset.action !== 'stop';
  });
  if (name) status(name);
  updateFloorControls();
}
async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || data.success === false) throw new Error(data.message || `서버 오류 (${response.status})`);
  return data;
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
  $('#saveFloorPricesBtn').disabled = state.busy || count === 0;
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
    if (Array.isArray(data.items) && (data.items.length || data.comparisonComplete)) { state.targets = data.items; renderTargets(); }
  } catch (error) { log(`수정 대상 조회 실패(기존 목록 유지): ${error.message}`, true); }
}
function renderTargets() {
  $('#targetCount').textContent = `(${state.targets.length}개)`;
  $('#targetBody').innerHTML = state.targets.length ? state.targets.map((item,index) => `<tr data-stock="${escapeHtml(item.stockId)}" data-price="${item.targetPrice}"><td>${index+1}</td><td>${escapeHtml(item.productName)}</td><td>${escapeHtml(item.optionName)}</td><td>${money(item.targetPrice)}</td><td>${escapeHtml(item.stockId)}</td><td class="row-status"><span class="badge ${item.updateStatus}">${labels[item.updateStatus] || '대기'}</span></td></tr>`).join('') : '<tr><td colspan="6" class="empty">수정 대상이 없습니다.</td></tr>';
  $$('#targetBody tr[data-stock]').forEach(row => row.onclick = () => editOne(row));
}
async function editOne(row) {
  if (state.busy) return;
  setBusy(true, `개별 수정 중 · ${row.dataset.stock}`); row.querySelector('.row-status').textContent = '수정 중';
  try { await jsonFetch(`/api/open-stock-edit?stockId=${encodeURIComponent(row.dataset.stock)}&newPrice=${row.dataset.price}`); row.querySelector('.row-status').innerHTML='<span class="badge COMPLETED">완료</span>'; log(`수정 완료: stockId=${row.dataset.stock}`); await loadSummary(); }
  catch (error) { if (!state.stopped) { row.querySelector('.row-status').innerHTML='<span class="badge FAILED">실패</span>'; log(`수정 실패: ${error.message}`, true); } }
  finally { setBusy(false, '대기 중'); }
}
async function editOneDirect(row) {
  row.querySelector('.row-status').textContent='수정 중';
  try { await jsonFetch(`/api/open-stock-edit?stockId=${encodeURIComponent(row.dataset.stock)}&newPrice=${row.dataset.price}`); row.querySelector('.row-status').innerHTML='<span class="badge COMPLETED">완료</span>'; }
  catch (error) { if (!state.stopped) { row.querySelector('.row-status').innerHTML='<span class="badge FAILED">실패</span>'; log(`수정 실패 ${row.dataset.stock}: ${error.message}`, true); } }
}
async function autoEdit() {
  if (state.busy || !state.targets.length) { if (!state.targets.length) status('수정 대상이 없습니다.'); return; }
  state.stopped=false; setBusy(true,'전체 자동수정 시작');
  for (let index=0; index<state.targets.length && !state.stopped; index++) { const row=$(`#targetBody tr[data-stock="${CSS.escape(String(state.targets[index].stockId))}"]`); status(`전체 자동수정 ${index+1}/${state.targets.length}`); await editOneDirect(row); }
  setBusy(false,state.stopped?'작업 중지됨':'전체 자동수정 완료'); await Promise.all([loadSummary(),loadInventory()]);
}

async function compareSelected() {
  const stockIds = [...state.selected];
  if (!stockIds.length) { status('가격 비교할 재고를 선택하세요.'); log('가격 비교할 재고를 선택하세요.'); return; }
  if (state.busy) return;
  state.stopped=false; setBusy(true,`선택 재고 ${stockIds.length}개 가격 비교 중`);
  try {
    const result = await jsonFetch('/api/compare-selected', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({stockIds}) });
    log(`선택 재고 ${result.total}개 가격 비교 완료`); status(`선택 재고 ${result.total}개 가격 비교 완료`);
    await Promise.all([loadSummary(),loadInventory(),loadTargets()]);
  } catch (error) { if (!state.stopped) { log(`선택 가격 비교 실패: ${error.message}`, true); status('선택 가격 비교 실패'); } }
  finally { setBusy(false); }
}
async function runTask(url,label) {
  if (state.busy) return; state.stopped=false; setBusy(true,`${label} 진행 중`); log(`${label} 시작`);
  try { const data=await jsonFetch(url,{method:'POST'}); log(`${label} 완료${data.total!==undefined?` · ${data.total}개`:''}`); status(`${label} 완료`); await Promise.all([loadSummary(),loadInventory(),loadTargets()]); }
  catch (error) { if (!state.stopped) { log(`${label} 실패: ${error.message}`,true); status(`${label} 실패`); } }
  finally { setBusy(false); }
}
async function stop() { state.stopped=true; try { await jsonFetch('/api/stop',{method:'POST'}); log('전체 작업 중지 요청 완료'); status('작업 중지됨'); } catch(error) { log(`중지 요청 실패: ${error.message}`,true); } finally { setBusy(false); } }
async function runLegacy(button) { if(state.busy)return; const label=button.textContent.trim(); state.stopped=false; setBusy(true,`${label} 진행 중`); log(`${label} 시작`); try { await jsonFetch(`/run/${button.dataset.legacy}`); log(`${label} 완료`); await Promise.all([loadSummary(),loadInventory(),loadTargets()]); } catch(error) { if(!state.stopped)log(`${label} 실패: ${error.message}`,true); } finally { setBusy(false,'대기 중'); } }

$$('[data-action]').forEach(button => button.onclick = () => ({ sync:()=>runTask('/api/inventory/sync','판매목록 동기화'), compare:compareSelected, auto:autoEdit, stop }[button.dataset.action]()));
$$('[data-legacy]').forEach(button => button.onclick = () => runLegacy(button));
$('#compareSelectedBtn').onclick = compareSelected;
$('#saveFloorPricesBtn').onclick = saveFloorPrices;
$('#clearSelectionBtn').onclick = () => { state.selected.clear(); $$('.inventory-select').forEach(input => input.checked=false); updateSelectionUI(); };
$('#selectVisible').onchange = event => { state.inventory.forEach(item => event.target.checked ? state.selected.add(String(item.stockId)) : state.selected.delete(String(item.stockId))); renderInventory(); };
$('#refreshBtn').onclick = () => Promise.all([loadInventory(),loadSummary()]);
$('#targetRefresh').onclick = loadTargets; $('#clearLog').onclick = () => $('#log').textContent=''; $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
let timer;
$('#search').oninput = () => { clearTimeout(timer); timer=setTimeout(()=>{state.page=1;loadInventory();},300); };
$('#statusFilter').onchange = $('#category').onchange = () => { state.page=1;loadInventory(); };
$('#resetFilters').onclick = () => { $('#search').value=$('#statusFilter').value=$('#category').value=''; state.page=1;loadInventory(); };
$('#pageSize').onchange = event => { state.pageSize=Number(event.target.value);state.page=1;loadInventory(); };
$('#prevPage').onclick = () => { if(state.page>1){state.page--;loadInventory();} };
$('#nextPage').onclick = () => { if(state.page<state.pages){state.page++;loadInventory();} };
function connectLogs() { const source=new EventSource('/logs'); source.onopen=()=>log('실시간 로그 연결됨'); source.onmessage=event=>{const text=event.data.replace(/\\n/g,'\n');if(text.startsWith('__'))return;text.split('\n').forEach(line=>log(line));}; source.onerror=()=>{source.close();setTimeout(connectLogs,2000);}; }
connectLogs(); updateFloorControls(); updateSelectionUI(); Promise.all([loadSummary(),loadInventory(),loadTargets()]);
