const fs = require('fs');
const path = require('path');
const { LOG_DIR, ensureRuntimeDirectories } = require('./config');

const LOG_TYPES = Object.freeze(['app', 'error', 'update', 'inventory', 'compare']);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVES = 5;

function assertType(type) {
  if (!LOG_TYPES.includes(type)) throw new Error('지원하지 않는 로그 종류입니다.');
  return type;
}

function getLogPath(type) {
  return path.join(LOG_DIR, `${assertType(type)}.log`);
}

function rotate(type) {
  const file = getLogPath(type);
  if (!fs.existsSync(file) || fs.statSync(file).size < MAX_BYTES) return;
  const oldest = `${file}.${MAX_ARCHIVES}`;
  if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
  for (let index = MAX_ARCHIVES - 1; index >= 1; index -= 1) {
    const source = `${file}.${index}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${file}.${index + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

function write(type, message) {
  try {
    ensureRuntimeDirectories();
    rotate(type);
    const safeMessage = String(message ?? '').replace(/\u001b\[[0-9;]*m/g, '');
    fs.appendFileSync(getLogPath(type), `[${new Date().toISOString()}] ${safeMessage}${safeMessage.endsWith('\n') ? '' : '\n'}`, 'utf8');
  } catch (error) {
    process.stderr.write(`로그 파일 기록 실패: ${error.message}\n`);
  }
}

function read(type, options = {}) {
  const file = getLogPath(type);
  const limit = Math.min(500, Math.max(1, Number(options.lines) || 500));
  const search = String(options.search || '').slice(0, 100).toLocaleLowerCase('ko-KR');
  if (!fs.existsSync(file)) return { type, lines: [], fileName: path.basename(file) };
  let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  if (search) lines = lines.filter(line => line.toLocaleLowerCase('ko-KR').includes(search));
  return { type, lines: lines.slice(-limit), fileName: path.basename(file) };
}

function clear(type) {
  fs.writeFileSync(getLogPath(type), '', 'utf8');
}

ensureRuntimeDirectories();

module.exports = { LOG_TYPES, MAX_BYTES, MAX_ARCHIVES, getLogPath, write, read, clear };
