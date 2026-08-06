const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fileLogger = require('./file-logger');
const config = require('./config');

const DEFAULT_SETTINGS = Object.freeze({
  autoUpdateEnabled: false,
  autoUpdateTime: '04:00',
  autoApply: false,
  deferWhenBusy: true,
  rollbackOnFailure: true,
  backupRetention: 30
});
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const UPDATE_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function atomicWriteJson(file, value) {
  config.ensureRuntimeDirectories();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  } catch (error) {
    fileLogger.write('error', `${path.basename(file)} 읽기 실패: ${error.message}`);
    return fallback;
  }
}

function normalizeSettings(value = {}) {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.autoUpdateTime || ''))
    ? String(value.autoUpdateTime)
    : DEFAULT_SETTINGS.autoUpdateTime;
  const retention = Math.min(365, Math.max(1, Number(value.backupRetention) || DEFAULT_SETTINGS.backupRetention));
  return {
    autoUpdateEnabled: value.autoUpdateEnabled === true,
    autoUpdateTime: time,
    autoApply: value.autoApply === true,
    deferWhenBusy: value.deferWhenBusy !== false,
    rollbackOnFailure: value.rollbackOnFailure !== false,
    backupRetention: retention
  };
}

function readSettings() {
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...readJson(config.SETTINGS_PATH, {}) });
}

function writeSettings(value) {
  const normalized = normalizeSettings(value);
  atomicWriteJson(config.SETTINGS_PATH, normalized);
  return normalized;
}

function readUpdateHistory() {
  const history = readJson(config.HISTORY_PATH, []);
  return Array.isArray(history) ? history.slice(0, 200) : [];
}

function appendUpdateHistory(entry) {
  const item = {
    timestamp: new Date().toISOString(),
    computer: os.hostname(),
    mode: 'manual',
    beforeCommit: null,
    afterCommit: null,
    success: false,
    rolledBack: false,
    durationMs: 0,
    errorSummary: '',
    ...entry
  };
  const history = [item, ...readUpdateHistory()].slice(0, 200);
  atomicWriteJson(config.HISTORY_PATH, history);
  return item;
}

function runCommand(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd || config.ROOT_DIR,
      env: options.env || process.env,
      shell: false,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${path.basename(file)} 실행 시간이 초과되었습니다.`));
    }, options.timeout || 15000);
    const collect = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-MAX_COMMAND_OUTPUT);
    child.stdout?.on('data', chunk => { stdout = collect(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = collect(stderr, chunk); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0 || options.allowFailure) resolve(result);
      else reject(new Error((stderr || stdout || `${path.basename(file)} 종료 코드 ${code}`).trim()));
    });
  });
}

async function safeCommand(file, args, options) {
  try {
    return await runCommand(file, args, options);
  } catch (error) {
    return { code: -1, stdout: '', stderr: error.message, error: error.message };
  }
}

function maskText(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s@/]+:[^\s@/]+@/gi, 'https://***:***@')
    .replace(/(token|password|authorization)=([^\s&]+)/gi, '$1=***');
}

function getInternalIp() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

class AdminPinGuard {
  constructor() {
    this.failures = new Map();
    this.windowMs = 15 * 60 * 1000;
    this.maxFailures = 5;
  }

  isConfigured() {
    return Boolean(String(process.env.KREAM_SYSTEM_ADMIN_PIN || '').trim());
  }

  verify(clientKey, submittedPin) {
    const expected = String(process.env.KREAM_SYSTEM_ADMIN_PIN || '');
    if (!expected) return { ok: false, status: 503, message: '관리자 PIN이 설정되지 않았습니다. KREAM_SYSTEM_ADMIN_PIN 환경변수를 설정하세요.' };
    const key = String(clientKey || 'unknown');
    const now = Date.now();
    const record = this.failures.get(key);
    if (record && record.lockedUntil > now) {
      return { ok: false, status: 429, message: '관리자 인증 시도가 잠겼습니다. 잠시 후 다시 시도하세요.' };
    }
    const submitted = String(submittedPin || '');
    const expectedBuffer = Buffer.from(expected);
    const submittedBuffer = Buffer.from(submitted);
    const ok = expectedBuffer.length === submittedBuffer.length && crypto.timingSafeEqual(expectedBuffer, submittedBuffer);
    if (ok) {
      this.failures.delete(key);
      return { ok: true };
    }
    const recent = record && now - record.firstFailure < this.windowMs
      ? record
      : { count: 0, firstFailure: now, lockedUntil: 0 };
    recent.count += 1;
    if (recent.count >= this.maxFailures) recent.lockedUntil = now + this.windowMs;
    this.failures.set(key, recent);
    return { ok: false, status: recent.lockedUntil ? 429 : 401, message: '관리자 PIN이 올바르지 않습니다.' };
  }
}

class SystemManager {
  constructor(options) {
    this.inventoryDb = options.inventoryDb;
    this.chromium = options.chromium;
    this.getJobState = options.getJobState || (() => ({ busy: false, name: null }));
    this.startedAt = Date.now();
    this.adminPin = new AdminPinGuard();
    this.systemBrowser = null;
    config.ensureRuntimeDirectories();
    if (!fs.existsSync(config.SETTINGS_PATH)) writeSettings(DEFAULT_SETTINGS);
  }

  async git(args, options = {}) {
    return runCommand('git.exe', args, { cwd: config.ROOT_DIR, timeout: options.timeout || 20000 });
  }

  async getVersion(fetchRemote = false) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(config.ROOT_DIR, 'package.json'), 'utf8'));
    const result = {
      appVersion: packageJson.version || '0.0.0',
      branch: null,
      currentCommit: null,
      currentCommitShort: null,
      commitDate: null,
      dirty: false,
      remoteName: null,
      remoteCommit: null,
      remoteCommitShort: null,
      latest: null,
      ahead: 0,
      behind: 0,
      updates: [],
      gitError: null
    };
    try {
      result.branch = (await this.git(['branch', '--show-current'])).stdout || 'HEAD';
      result.currentCommit = (await this.git(['rev-parse', 'HEAD'])).stdout;
      result.currentCommitShort = result.currentCommit.slice(0, 7);
      result.commitDate = (await this.git(['show', '-s', '--format=%cI', 'HEAD'])).stdout;
      result.dirty = Boolean((await this.git(['status', '--porcelain'])).stdout);
      const remotes = (await this.git(['remote'])).stdout.split(/\r?\n/).filter(Boolean);
      result.remoteName = remotes.includes('origin') ? 'origin' : remotes[0] || null;
      if (!result.remoteName || !result.branch || result.branch === 'HEAD') return result;
      if (fetchRemote) await this.git(['fetch', '--prune', result.remoteName, result.branch], { timeout: 120000 });
      const remoteRef = `refs/remotes/${result.remoteName}/${result.branch}`;
      try {
        result.remoteCommit = (await this.git(['rev-parse', '--verify', remoteRef])).stdout;
      } catch (error) {
        result.gitError = fetchRemote
          ? maskText(error.message).slice(0, 500)
          : `${result.remoteName}/${result.branch} 원격 참조가 없습니다. 업데이트 확인을 실행하세요.`;
        return result;
      }
      result.remoteCommitShort = result.remoteCommit.slice(0, 7);
      const counts = (await this.git(['rev-list', '--left-right', '--count', `${result.currentCommit}...${result.remoteCommit}`])).stdout.split(/\s+/).map(Number);
      result.ahead = counts[0] || 0;
      result.behind = counts[1] || 0;
      result.latest = result.behind === 0;
      if (result.behind > 0) {
        result.updates = (await this.git(['log', '--format=%s', '--max-count=20', `${result.currentCommit}..${result.remoteCommit}`])).stdout.split(/\r?\n/).filter(Boolean);
      }
    } catch (error) {
      result.gitError = maskText(error.message).slice(0, 500);
      if (fetchRemote) fileLogger.write('error', `Git 업데이트 확인 실패: ${result.gitError}`);
    }
    return result;
  }

  async getServiceStatus() {
    const query = await safeCommand('sc.exe', ['query', config.SERVICE_NAME], { timeout: 10000 });
    const qc = await safeCommand('sc.exe', ['qc', config.SERVICE_NAME], { timeout: 10000 });
    // sc.exe localizes field labels on Korean Windows, but state values remain English.
    const stateMatch = query.stdout.match(/:\s*\d+\s+(STOPPED|START_PENDING|STOP_PENDING|RUNNING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)/i);
    const startMatch = qc.stdout.match(/START_TYPE\s*:\s*\d+\s+(\w+)/i);
    return {
      name: config.SERVICE_NAME,
      installed: query.code === 0,
      state: stateMatch?.[1] || 'UNKNOWN',
      startType: startMatch?.[1] || 'UNKNOWN',
      nssmPath: config.getNssmPath(),
      error: query.code === 0 ? null : maskText(query.stderr || query.stdout).slice(0, 300)
    };
  }

  isUpdateRunning() {
    if (!fs.existsSync(config.UPDATE_LOCK_PATH)) return false;
    try {
      const age = Date.now() - fs.statSync(config.UPDATE_LOCK_PATH).mtimeMs;
      if (age <= UPDATE_LOCK_MAX_AGE_MS) return true;
      fs.rmSync(config.UPDATE_LOCK_PATH, { force: true });
      fileLogger.write('update', '오래된 업데이트 잠금 파일을 정리했습니다.');
    } catch {
      return true;
    }
    return false;
  }

  reserveUpdate() {
    if (this.isUpdateRunning()) throw new Error('이미 업데이트가 진행 중입니다.');
    const token = crypto.randomUUID();
    const descriptor = fs.openSync(config.UPDATE_LOCK_PATH, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
    fs.closeSync(descriptor);
    return token;
  }

  async getStatus() {
    const [service, version] = await Promise.all([this.getServiceStatus(), this.getVersion(false)]);
    const job = this.getJobState();
    return {
      computerName: os.hostname(),
      internalIp: getInternalIp(),
      service,
      version,
      uptimeSeconds: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
      job,
      updateInProgress: this.isUpdateRunning(),
      adminPinConfigured: this.adminPin.isConfigured(),
      settings: readSettings(),
      checkedAt: new Date().toISOString()
    };
  }

  async getChromeStatus() {
    const result = {
      connected: false,
      cdp: config.CDP_URL.replace(/^https?:\/\//, ''),
      chromeProcessRunning: false,
      browserVersion: null,
      contextCount: 0,
      pageCount: 0,
      hasKreamPage: false,
      loginStatus: 'UNKNOWN',
      checkedAt: new Date().toISOString(),
      error: null
    };
    const processes = await safeCommand('tasklist.exe', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { timeout: 10000 });
    result.chromeProcessRunning = /chrome\.exe/i.test(processes.stdout);
    try {
      if (!this.systemBrowser || !this.systemBrowser.isConnected()) {
        this.systemBrowser = await this.chromium.connectOverCDP(config.CDP_URL, { timeout: 8000 });
      }
      const contexts = this.systemBrowser.contexts();
      const pages = contexts.flatMap(context => context.pages());
      result.connected = true;
      result.chromeProcessRunning = true;
      result.browserVersion = this.systemBrowser.version();
      result.contextCount = contexts.length;
      result.pageCount = pages.length;
      const kreamPages = pages.filter(page => {
        try { return /(^|\.)kream\.co\.kr/i.test(new URL(page.url()).hostname); }
        catch { return false; }
      });
      result.hasKreamPage = kreamPages.length > 0;
      if (kreamPages.length) {
        const page = kreamPages.find(candidate => /partner\.kream\.co\.kr|\/business\//i.test(candidate.url())) || kreamPages[0];
        const url = page.url();
        const passwordVisible = await page.locator('input[type="password"]:visible').count().catch(() => 0);
        if (/login|signin/i.test(url) || passwordVisible) result.loginStatus = 'LOGIN_REQUIRED';
        else if (/partner\.kream\.co\.kr|business/i.test(url)) result.loginStatus = 'LOGGED_IN';
      }
    } catch (error) {
      this.systemBrowser = null;
      result.error = maskText(error.message).slice(0, 300);
    }
    return result;
  }

  async getSystemInfo() {
    const [status, chrome, npmResult] = await Promise.all([
      this.getStatus(),
      this.getChromeStatus(),
      safeCommand(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd --version'] : ['--version'], { timeout: 10000 })
    ]);
    const dbExists = fs.existsSync(this.inventoryDb.DB_PATH);
    const dbSize = [this.inventoryDb.DB_PATH, `${this.inventoryDb.DB_PATH}-wal`, `${this.inventoryDb.DB_PATH}-shm`]
      .filter(file => fs.existsSync(file))
      .reduce((total, file) => total + fs.statSync(file).size, 0);
    let playwrightVersion = null;
    try { playwrightVersion = require('playwright/package.json').version; } catch {}
    return {
      windowsVersion: `${os.type()} ${os.release()} (${os.arch()})`,
      computerName: status.computerName,
      internalIp: status.internalIp,
      nodeVersion: process.version,
      npmVersion: npmResult.stdout || null,
      playwrightVersion,
      chromeVersion: chrome.browserVersion,
      projectPath: config.ROOT_DIR,
      port: config.PORT,
      service: status.service,
      serverUptimeSeconds: status.uptimeSeconds,
      memory: status.memory,
      job: status.job,
      dbPath: this.inventoryDb.DB_PATH,
      dbSize: dbExists ? dbSize : 0,
      gitRemoteName: status.version.remoteName,
      settings: status.settings
    };
  }

  listBackups() {
    config.ensureRuntimeDirectories();
    return fs.readdirSync(config.BACKUP_DIR)
      .filter(name => /^kream_\d{4}-\d{2}-\d{2}_\d{6}(?:_\d+)?\.db$/.test(name))
      .map(name => {
        const fullPath = path.join(config.BACKUP_DIR, name);
        const stat = fs.statSync(fullPath);
        return { name, size: stat.size, createdAt: stat.birthtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  cleanupBackups(retention = readSettings().backupRetention) {
    const backups = this.listBackups();
    backups.slice(Math.max(1, retention)).forEach(item => fs.rmSync(path.join(config.BACKUP_DIR, item.name), { force: true }));
  }

  createBackup() {
    const integrity = this.inventoryDb.db.prepare('PRAGMA integrity_check').get();
    if (!integrity || !Object.values(integrity).includes('ok')) throw new Error('DB 무결성 검사에 실패했습니다.');
    const current = new Date();
    const local = value => String(value).padStart(2, '0');
    const stamp = `${current.getFullYear()}-${local(current.getMonth() + 1)}-${local(current.getDate())}_${local(current.getHours())}${local(current.getMinutes())}${local(current.getSeconds())}`;
    let name = `kream_${stamp}.db`;
    let index = 1;
    while (fs.existsSync(path.join(config.BACKUP_DIR, name))) name = `kream_${stamp}_${index++}.db`;
    const destination = path.join(config.BACKUP_DIR, name);
    const escaped = destination.replace(/'/g, "''");
    this.inventoryDb.db.exec(`VACUUM INTO '${escaped}'`);
    const backupDb = new DatabaseSync(destination, { readOnly: true });
    const backupIntegrity = backupDb.prepare('PRAGMA integrity_check').get();
    backupDb.close();
    if (!backupIntegrity || !Object.values(backupIntegrity).includes('ok')) {
      fs.rmSync(destination, { force: true });
      throw new Error('생성된 백업 파일의 무결성 검사에 실패했습니다.');
    }
    this.cleanupBackups();
    const item = this.listBackups().find(backup => backup.name === name);
    fileLogger.write('app', `DB 백업 완료: ${name} (${item.size} bytes)`);
    return item;
  }

  getBackupPath(name) {
    const safeName = path.basename(String(name || ''));
    const item = this.listBackups().find(backup => backup.name === safeName);
    if (!item) throw new Error('백업 파일을 찾을 수 없습니다.');
    return path.join(config.BACKUP_DIR, item.name);
  }

  deleteBackup(name) {
    const backups = this.listBackups();
    const safeName = path.basename(String(name || ''));
    if (!backups.some(item => item.name === safeName)) throw new Error('백업 파일을 찾을 수 없습니다.');
    if (backups[0]?.name === safeName) throw new Error('가장 최근 백업은 삭제할 수 없습니다.');
    fs.rmSync(path.join(config.BACKUP_DIR, safeName), { force: true });
    return safeName;
  }

  spawnDetachedPowerShell(scriptName, args = []) {
    const scriptPath = path.join(config.ROOT_DIR, 'scripts', scriptName);
    if (!fs.existsSync(scriptPath)) throw new Error(`${scriptName} 파일을 찾을 수 없습니다.`);
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
      cwd: config.ROOT_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false
    });
    child.unref();
    return child.pid;
  }

  requestUpdate(mode = 'Manual') {
    const job = this.getJobState();
    if (job.busy) throw new Error(`현재 ${job.name || '자동화'} 작업이 진행 중이라 업데이트할 수 없습니다.`);
    const token = this.reserveUpdate();
    try {
      const pid = this.spawnDetachedPowerShell('update.ps1', ['-Mode', mode, '-RestartService', '-LockToken', token]);
      fileLogger.write('update', `${mode} 업데이트 요청 수락: worker pid=${pid}`);
      return { accepted: true, workerPid: pid };
    } catch (error) {
      fs.rmSync(config.UPDATE_LOCK_PATH, { force: true });
      throw error;
    }
  }

  requestRestart() {
    const job = this.getJobState();
    if (job.busy) throw new Error(`현재 ${job.name || '자동화'} 작업이 진행 중이라 재시작할 수 없습니다.`);
    const pid = this.spawnDetachedPowerShell('restart-service.ps1', ['-DelaySeconds', '2']);
    fileLogger.write('app', `KREAMBOT 서비스 재시작 요청 수락: worker pid=${pid}`);
    return { accepted: true, workerPid: pid };
  }

  async updateAutoUpdateSettings(input) {
    const next = normalizeSettings({ ...readSettings(), ...input });
    const script = next.autoUpdateEnabled ? 'register-auto-update.ps1' : 'remove-auto-update.ps1';
    const args = next.autoUpdateEnabled
      ? ['-Time', next.autoUpdateTime, '-AutoApply', String(next.autoApply), '-RollbackOnFailure', String(next.rollbackOnFailure)]
      : [];
    const scriptPath = path.join(config.ROOT_DIR, 'scripts', script);
    const result = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], { timeout: 30000 });
    writeSettings(next);
    fileLogger.write('app', `자동 업데이트 설정 변경: ${next.autoUpdateEnabled ? `ON ${next.autoUpdateTime}` : 'OFF'}`);
    return { settings: next, output: maskText(result.stdout).slice(-1000) };
  }

  updateBackupRetention(value) {
    const retention = Number(value);
    if (!Number.isInteger(retention) || retention < 1 || retention > 365) {
      throw new Error('백업 보관 개수는 1~365 사이의 정수여야 합니다.');
    }
    const settings = writeSettings({ ...readSettings(), backupRetention: retention });
    this.cleanupBackups(settings.backupRetention);
    fileLogger.write('app', `DB 백업 보관 개수 변경: ${settings.backupRetention}개`);
    return settings;
  }
}

module.exports = {
  SystemManager,
  AdminPinGuard,
  DEFAULT_SETTINGS,
  readSettings,
  writeSettings,
  readUpdateHistory,
  appendUpdateHistory,
  runCommand,
  maskText,
  config
};
