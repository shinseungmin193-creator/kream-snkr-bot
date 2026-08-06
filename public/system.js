(() => {
  const systemState = { status: null, version: null, logTimer: null, loaded: false, messageTimer: null };
  const byId = id => document.getElementById(id);
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const formatBytes = value => {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  };
  const formatDuration = seconds => {
    const total = Math.max(0, Number(seconds) || 0);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `${days ? `${days}일 ` : ''}${hours}시간 ${minutes}분`;
  };
  const dateTime = value => value ? new Date(value).toLocaleString('ko-KR') : '-';

  async function api(url, options = {}) {
    const response = await fetch(url, options);
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data.success === false) throw new Error(data.message || `서버 오류 (${response.status})`);
    return data;
  }

  function message(text, isError = false) {
    const element = byId('systemMessage');
    clearTimeout(systemState.messageTimer);
    element.textContent = text;
    element.classList.toggle('error', isError);
    element.classList.add('show');
    systemState.messageTimer = setTimeout(() => element.classList.remove('show'), 4500);
  }

  function setPill(id, text, tone = '') {
    const element = byId(id);
    element.textContent = text;
    element.className = `system-pill${tone ? ` ${tone}` : ''}`;
  }

  function showSystemView(enabled, anchor = null) {
    document.querySelectorAll('.dashboard-view').forEach(element => { element.hidden = enabled; });
    byId('system').hidden = !enabled;
    document.querySelectorAll('#sidebar a').forEach(link => link.classList.toggle('active', enabled ? link.dataset.view === 'system' : link.hash === anchor || (!anchor && link.hash === '#dashboard')));
    if (enabled) {
      if (!systemState.loaded) refreshSystem();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (anchor && anchor !== '#dashboard') {
      setTimeout(() => document.querySelector(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    } else window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.querySelectorAll('#sidebar a').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      const system = link.dataset.view === 'system';
      history.replaceState(null, '', link.hash);
      showSystemView(system, link.hash);
    });
  });
  window.addEventListener('hashchange', () => showSystemView(location.hash === '#system', location.hash || '#dashboard'));

  async function requestAdminPin() {
    const dialog = byId('adminDialog');
    const input = byId('adminPinInput');
    input.value = '';
    dialog.returnValue = '';
    dialog.showModal();
    setTimeout(() => input.focus(), 0);
    return new Promise(resolve => {
      dialog.addEventListener('close', () => {
        const value = dialog.returnValue === 'confirm' ? input.value : null;
        input.value = '';
        resolve(value);
      }, { once: true });
    });
  }

  async function adminApi(url, options = {}) {
    const pin = await requestAdminPin();
    if (pin === null) throw new Error('관리자 작업이 취소되었습니다.');
    const headers = new Headers(options.headers || {});
    headers.set('X-KREAM-ADMIN-PIN', pin);
    return api(url, { ...options, headers });
  }

  function renderVersion(version) {
    systemState.version = version;
    byId('versionFooter').textContent = `KREAM BOT v${version.appVersion} · ${version.currentCommitShort || '-------'}`;
    let stateText = '상태 미확인';
    let tone = 'warn';
    if (version.gitError) { stateText = 'Git 확인 오류'; tone = 'error'; }
    else if (version.behind > 0) { stateText = `업데이트 ${version.behind}개`; tone = 'warn'; }
    else if (version.latest) { stateText = '최신 버전'; tone = 'ok'; }
    if (version.dirty) { stateText = '로컬 변경 있음'; tone = 'warn'; }
    setPill('versionState', stateText, tone);
    byId('versionDetails').innerHTML = `<strong>KREAM BOT v${escapeHtml(version.appVersion)}</strong><dl><dt>브랜치</dt><dd>${escapeHtml(version.branch || '-')}</dd><dt>현재 커밋</dt><dd>${escapeHtml(version.currentCommitShort || '-')}</dd><dt>커밋 날짜</dt><dd>${escapeHtml(dateTime(version.commitDate))}</dd><dt>Git 상태</dt><dd>${version.gitError ? escapeHtml(version.gitError) : version.dirty ? '로컬 변경사항 있음' : '깨끗함'}</dd><dt>GitHub 최신</dt><dd>${escapeHtml(version.remoteCommitShort || '-')}</dd></dl>`;
    byId('updateCommits').innerHTML = (version.updates || []).map(title => `<li>${escapeHtml(title)}</li>`).join('');
    updateDangerousControls();
  }

  async function loadVersion(fetchRemote = false) {
    try {
      const data = fetchRemote
        ? await api('/api/system/check-update', { method: 'POST' })
        : await api('/api/system/version');
      renderVersion(data.version);
      if (fetchRemote) message(data.version.gitError ? `업데이트 확인 실패: ${data.version.gitError}` : data.version.behind ? `새 업데이트 ${data.version.behind}개가 있습니다.` : '현재 최신 버전입니다.', Boolean(data.version.gitError));
    } catch (error) { setPill('versionState', '확인 실패', 'error'); message(`버전 확인 실패: ${error.message}`, true); }
  }

  function updateDangerousControls() {
    const configured = systemState.status?.adminPinConfigured === true;
    const blocked = !configured;
    ['restartServerBtn', 'saveAutoUpdateBtn', 'deleteSystemLog', 'saveRetentionBtn'].forEach(id => { byId(id).disabled = blocked; });
    byId('applyUpdateBtn').disabled = blocked || systemState.version?.dirty === true || systemState.status?.updateInProgress === true;
    const notice = byId('adminNotice');
    notice.classList.toggle('show', blocked);
    notice.textContent = blocked ? '위험 작업이 잠겨 있습니다. NSSM 서비스 환경에 KREAM_SYSTEM_ADMIN_PIN을 설정한 뒤 서비스를 재시작하세요.' : '';
  }

  async function loadStatus() {
    try {
      const data = await api('/api/system/status');
      systemState.status = data;
      const service = data.service;
      const running = service.installed && service.state === 'RUNNING';
      setPill('serviceState', running ? 'Running' : service.installed ? service.state : '미등록', running ? 'ok' : 'error');
      byId('serviceDetails').innerHTML = `<strong>${escapeHtml(service.name)}</strong><dl><dt>시작 유형</dt><dd>${escapeHtml(service.startType)}</dd><dt>현재 작업</dt><dd>${data.job.busy ? escapeHtml(data.job.name || '진행 중') : '대기'}</dd><dt>가동 시간</dt><dd>${escapeHtml(formatDuration(data.uptimeSeconds))}</dd><dt>업데이트</dt><dd>${data.updateInProgress ? '진행 중' : '대기'}</dd></dl>`;
      updateDangerousControls();
    } catch (error) { setPill('serviceState', '확인 실패', 'error'); message(`서비스 상태 확인 실패: ${error.message}`, true); }
  }

  async function loadChrome() {
    try {
      const { chrome } = await api('/api/system/chrome-status');
      setPill('chromeState', chrome.connected ? '연결됨' : '연결 안 됨', chrome.connected ? 'ok' : 'error');
      const login = chrome.loginStatus === 'LOGGED_IN' ? '로그인됨' : chrome.loginStatus === 'LOGIN_REQUIRED' ? '로그인 필요' : '확인 불가';
      byId('chromeDetails').innerHTML = `<strong>${chrome.connected ? 'Chrome CDP 연결됨' : 'Chrome 연결 안 됨'}</strong><dl><dt>KREAM</dt><dd>${escapeHtml(login)}</dd><dt>CDP</dt><dd>${escapeHtml(chrome.cdp)}</dd><dt>프로세스</dt><dd>${chrome.chromeProcessRunning ? '실행 중' : '찾을 수 없음'}</dd><dt>컨텍스트</dt><dd>${chrome.contextCount}개</dd><dt>열린 페이지</dt><dd>${chrome.pageCount}개</dd><dt>확인 시간</dt><dd>${escapeHtml(dateTime(chrome.checkedAt))}</dd></dl>${chrome.error ? `<p>${escapeHtml(chrome.error)}</p>` : ''}`;
    } catch (error) { setPill('chromeState', '확인 실패', 'error'); message(`Chrome 확인 실패: ${error.message}`, true); }
  }

  async function loadBackups() {
    try {
      const data = await api('/api/system/backups');
      byId('backupRetention').value = data.retention;
      setPill('backupState', `${data.items.length}개`, data.items.length ? 'ok' : '');
      byId('backupList').innerHTML = data.items.length ? data.items.map((item, index) => `<div class="backup-item"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(dateTime(item.createdAt))} · ${escapeHtml(formatBytes(item.size))}</small></div><div><button data-backup-download="${encodeURIComponent(item.name)}">다운로드</button>${index ? `<button class="delete" data-backup-delete="${encodeURIComponent(item.name)}">삭제</button>` : ''}</div></div>`).join('') : '<div class="backup-item">생성된 백업이 없습니다.</div>';
      document.querySelectorAll('[data-backup-download]').forEach(button => button.onclick = () => { location.href = `/api/system/backups/${button.dataset.backupDownload}/download`; });
      document.querySelectorAll('[data-backup-delete]').forEach(button => button.onclick = async () => {
        if (!confirm('이 백업 파일을 삭제하시겠습니까?')) return;
        try { await adminApi(`/api/system/backups/${button.dataset.backupDelete}`, { method: 'DELETE' }); message('백업을 삭제했습니다.'); await loadBackups(); }
        catch (error) { message(error.message, true); }
      });
    } catch (error) { setPill('backupState', '확인 실패', 'error'); message(`백업 조회 실패: ${error.message}`, true); }
  }

  async function loadLogs() {
    const type = byId('systemLogType').value;
    const search = byId('systemLogSearch').value.trim();
    try {
      const data = await api(`/api/system/logs?type=${encodeURIComponent(type)}&lines=500&search=${encodeURIComponent(search)}`);
      byId('systemLogOutput').textContent = data.lines.length ? data.lines.join('\n') : '표시할 로그가 없습니다.';
      setPill('systemLogCount', `${data.lines.length}줄`, data.lines.length ? 'ok' : '');
    } catch (error) { byId('systemLogOutput').textContent = `로그 조회 실패: ${error.message}`; setPill('systemLogCount', '확인 실패', 'error'); }
  }

  async function loadAutoUpdate() {
    try {
      const { settings } = await api('/api/system/auto-update');
      byId('autoUpdateEnabled').checked = settings.autoUpdateEnabled;
      byId('autoUpdateTime').value = settings.autoUpdateTime;
      byId('autoApply').checked = settings.autoApply;
      byId('deferWhenBusy').checked = settings.deferWhenBusy;
      byId('rollbackOnFailure').checked = settings.rollbackOnFailure;
      setPill('autoUpdateState', settings.autoUpdateEnabled ? 'ON' : 'OFF', settings.autoUpdateEnabled ? 'ok' : '');
    } catch (error) { setPill('autoUpdateState', '확인 실패', 'error'); message(error.message, true); }
  }

  async function loadHistory() {
    try {
      const { items } = await api('/api/system/update-history');
      setPill('historyCount', `${items.length}건`, items.length ? 'ok' : '');
      byId('updateHistory').innerHTML = items.length ? items.map(item => `<div class="history-item"><div><strong class="${item.success ? 'success' : 'failed'}">${item.success ? '성공' : '실패'} · ${escapeHtml(item.mode || '-')}</strong><small>${escapeHtml(item.beforeCommit?.slice(0, 7) || '-')} → ${escapeHtml(item.afterCommit?.slice(0, 7) || '-')} ${item.rolledBack ? '· 롤백됨' : ''}</small>${item.errorSummary ? `<small>${escapeHtml(item.errorSummary)}</small>` : ''}</div><small>${escapeHtml(dateTime(item.timestamp))}<br>${escapeHtml(item.computer || '-')}</small></div>`).join('') : '<div class="history-item">업데이트 기록이 없습니다.</div>';
    } catch (error) { setPill('historyCount', '확인 실패', 'error'); }
  }

  async function loadSystemInfo() {
    try {
      const { info } = await api('/api/system/info');
      const fields = [
        ['Windows', info.windowsVersion], ['컴퓨터 이름', info.computerName], ['내부 IP', info.internalIp], ['Node.js', info.nodeVersion],
        ['npm', info.npmVersion], ['Playwright', info.playwrightVersion], ['Chrome', info.chromeVersion], ['실행 포트', info.port],
        ['서비스', `${info.service.name} / ${info.service.state}`], ['NSSM', info.service.nssmPath], ['서버 가동 시간', formatDuration(info.serverUptimeSeconds)], ['메모리', formatBytes(info.memory?.rss)],
        ['현재 작업', info.job?.busy ? info.job.name : '대기'], ['DB 위치', info.dbPath], ['DB 크기', formatBytes(info.dbSize)], ['Git remote', info.gitRemoteName], ['프로젝트 경로', info.projectPath]
      ];
      byId('systemInfo').innerHTML = fields.map(([label, value]) => `<div class="info-item"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value ?? '-')}</strong></div>`).join('');
      setPill('systemCheckedAt', new Date().toLocaleTimeString('ko-KR', { hour12: false }), 'ok');
    } catch (error) { byId('systemInfo').textContent = `시스템 정보 조회 실패: ${error.message}`; setPill('systemCheckedAt', '확인 실패', 'error'); }
  }

  async function refreshSystem() {
    systemState.loaded = true;
    await Promise.allSettled([loadStatus(), loadVersion(), loadChrome(), loadBackups(), loadLogs(), loadAutoUpdate(), loadHistory(), loadSystemInfo()]);
  }

  async function waitForServerRestart(previousUptime, label) {
    let disconnected = false;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await sleep(2000);
      try {
        const data = await api('/api/system/status', { cache: 'no-store' });
        if (disconnected || Number(data.uptimeSeconds) + 5 < Number(previousUptime)) {
          message(`${label} 완료`);
          await refreshSystem();
          return;
        }
      } catch { disconnected = true; }
    }
    message(`${label} 상태 확인 시간이 초과되었습니다. 시스템 상태를 다시 확인하세요.`, true);
  }

  byId('systemRefresh').onclick = refreshSystem;
  byId('checkUpdateBtn').onclick = () => loadVersion(true);
  byId('refreshChromeBtn').onclick = loadChrome;
  byId('applyUpdateBtn').onclick = async () => {
    if (!confirm('DB와 중요 파일을 백업한 뒤 최신 버전으로 업데이트하고 KREAMBOT 서비스를 재시작합니다. 계속하시겠습니까?')) return;
    try {
      const previousUptime = systemState.status?.uptimeSeconds || 0;
      const result = await adminApi('/api/system/apply-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      message(result.message);
      waitForServerRestart(previousUptime, '업데이트 및 서버 재시작');
    } catch (error) { message(error.message, true); }
  };
  byId('restartServerBtn').onclick = async () => {
    if (!confirm('KREAMBOT 서비스를 재시작하시겠습니까? 진행 중인 자동화 작업이 있으면 차단됩니다.')) return;
    try {
      const previousUptime = systemState.status?.uptimeSeconds || 0;
      const result = await adminApi('/api/system/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      message(result.message);
      waitForServerRestart(previousUptime, '서버 재시작');
    } catch (error) { message(error.message, true); }
  };
  byId('createBackupBtn').onclick = async () => {
    try { setPill('backupState', '백업 중', 'warn'); const { backup } = await api('/api/system/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); message(`DB 백업 완료: ${backup.name}`); await loadBackups(); }
    catch (error) { setPill('backupState', '실패', 'error'); message(error.message, true); }
  };
  byId('saveRetentionBtn').onclick = async () => {
    try { await adminApi('/api/system/backups/retention', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retention: Number(byId('backupRetention').value) }) }); message('백업 보관 설정을 저장했습니다.'); await loadBackups(); }
    catch (error) { message(error.message, true); }
  };
  byId('systemLogType').onchange = loadLogs;
  let logSearchTimer;
  byId('systemLogSearch').oninput = () => { clearTimeout(logSearchTimer); logSearchTimer = setTimeout(loadLogs, 300); };
  byId('systemLogAuto').onchange = event => {
    clearInterval(systemState.logTimer);
    systemState.logTimer = event.target.checked ? setInterval(loadLogs, 5000) : null;
  };
  byId('copySystemLog').onclick = async () => {
    try { await navigator.clipboard.writeText(byId('systemLogOutput').textContent); message('로그를 클립보드에 복사했습니다.'); }
    catch { message('클립보드 복사에 실패했습니다.', true); }
  };
  byId('downloadSystemLog').onclick = () => { location.href = `/api/system/logs/download?type=${encodeURIComponent(byId('systemLogType').value)}`; };
  byId('deleteSystemLog').onclick = async () => {
    if (!confirm('선택한 로그 파일의 내용을 삭제하시겠습니까?')) return;
    try { await adminApi(`/api/system/logs/${encodeURIComponent(byId('systemLogType').value)}`, { method: 'DELETE' }); message('로그를 삭제했습니다.'); await loadLogs(); }
    catch (error) { message(error.message, true); }
  };
  byId('saveAutoUpdateBtn').onclick = async () => {
    const body = {
      autoUpdateEnabled: byId('autoUpdateEnabled').checked,
      autoUpdateTime: byId('autoUpdateTime').value,
      autoApply: byId('autoApply').checked,
      deferWhenBusy: byId('deferWhenBusy').checked,
      rollbackOnFailure: byId('rollbackOnFailure').checked
    };
    try { const { settings } = await adminApi('/api/system/auto-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); setPill('autoUpdateState', settings.autoUpdateEnabled ? 'ON' : 'OFF', settings.autoUpdateEnabled ? 'ok' : ''); message('자동 업데이트 설정을 저장했습니다.'); }
    catch (error) { message(error.message, true); }
  };

  loadVersion();
  if (location.hash === '#system') showSystemView(true, '#system');
})();
