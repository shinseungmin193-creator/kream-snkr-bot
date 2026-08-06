const inventoryDb = require('../database');
const { SystemManager } = require('../system/system-manager');

try {
  const manager = new SystemManager({ inventoryDb });
  const backup = manager.createBackup();
  process.stdout.write(`${backup.name}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
