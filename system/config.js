const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const BACKUP_DIR = path.join(ROOT_DIR, 'backups');
const SERVICE_NAME = process.env.KREAM_SERVICE_NAME || 'KREAMBOT';
const AUTO_UPDATE_TASK_NAME = process.env.KREAM_AUTO_UPDATE_TASK_NAME || 'KREAMBOT-AutoUpdate';
const CDP_URL = process.env.KREAM_CDP_URL || 'http://127.0.0.1:9222';
const PORT = Math.max(1, Math.min(65535, Number(process.env.PORT) || 3000));

const SETTINGS_PATH = path.join(DATA_DIR, 'system-settings.json');
const HISTORY_PATH = path.join(DATA_DIR, 'update-history.json');
const UPDATE_LOCK_PATH = path.join(DATA_DIR, 'system-update.lock');

const NSSM_CANDIDATES = [
  process.env.KREAM_NSSM_PATH,
  path.join(ROOT_DIR, 'tools', 'nssm', 'win64', 'nssm.exe'),
  'C:\\Users\\tmdal\\Desktop\\개발\\nssm\\win64\\nssm.exe',
  'C:\\Tools\\nssm\\nssm.exe'
].filter(Boolean);

function ensureRuntimeDirectories() {
  [DATA_DIR, LOG_DIR, BACKUP_DIR].forEach(directory => fs.mkdirSync(directory, { recursive: true }));
}

function getNssmPath() {
  const configuredPath = (() => {
    try {
      const file = path.join(DATA_DIR, 'system-config.json');
      if (!fs.existsSync(file)) return null;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))?.nssmPath;
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  })();
  return [configuredPath, ...NSSM_CANDIDATES].find(candidate => candidate && fs.existsSync(candidate)) || null;
}

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  LOG_DIR,
  BACKUP_DIR,
  SERVICE_NAME,
  AUTO_UPDATE_TASK_NAME,
  CDP_URL,
  PORT,
  SETTINGS_PATH,
  HISTORY_PATH,
  UPDATE_LOCK_PATH,
  ensureRuntimeDirectories,
  getNssmPath
};
