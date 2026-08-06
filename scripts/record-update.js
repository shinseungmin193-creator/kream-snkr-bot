const { appendUpdateHistory } = require('../system/system-manager');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

try {
  const errorBase64 = argument('error-base64');
  appendUpdateHistory({
    timestamp: argument('timestamp') || new Date().toISOString(),
    computer: argument('computer'),
    mode: argument('mode', 'manual').toLowerCase(),
    beforeCommit: argument('before') || null,
    afterCommit: argument('after') || null,
    success: argument('success') === 'true',
    rolledBack: argument('rolled-back') === 'true',
    durationMs: Math.max(0, Number(argument('duration-ms')) || 0),
    errorSummary: errorBase64 ? Buffer.from(errorBase64, 'base64').toString('utf8').slice(0, 500) : ''
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
