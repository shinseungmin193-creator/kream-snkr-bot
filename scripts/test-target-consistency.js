const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const source = path.resolve(__dirname, '..', 'database.js');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kream-target-test-'));
let inventoryDb;

try {
  fs.copyFileSync(source, path.join(fixtureRoot, 'database.js'));
  inventoryDb = require(path.join(fixtureRoot, 'database.js'));

  const inventory = ['A', 'B', 'C', 'D'].map((stockId, index) => ({
    stockId,
    productId: String(index + 1),
    productName: `상품 ${stockId}`,
    optionName: '1BOX',
    currentPrice: 1000,
    totalQuantity: 1,
    remainingQuantity: 1
  }));
  inventoryDb.upsertInventory(inventory, true);
  inventoryDb.saveFloorPrice('B', 700);

  inventoryDb.applyComparison([
    { stockId: 'A', myPrice: 1000, lowestPrice: 1000, targetPrice: 900, needsUpdate: true },
    { stockId: 'B', myPrice: 1000, lowestPrice: 1000, targetPrice: 800, needsUpdate: true },
    { stockId: 'C', myPrice: 1000, lowestPrice: 1000, targetPrice: 1000, needsUpdate: false },
    { stockId: 'D', myPrice: 1000, lowestPrice: 1000, targetPrice: 950, needsUpdate: true }
  ]);

  let snapshot = inventoryDb.targetSnapshot();
  assert.deepStrictEqual(snapshot.items.map(item => item.stockId), ['A', 'B', 'D']);
  assert.strictEqual(snapshot.count, 3);
  assert.strictEqual(inventoryDb.summary().needsUpdate, snapshot.count);
  assert.strictEqual(new Set(snapshot.items.map(item => item.stockId)).size, snapshot.count);

  inventoryDb.applyComparison([
    { stockId: 'A', myPrice: 1000, lowestPrice: 1000, targetPrice: 1000, needsUpdate: false }
  ]);
  snapshot = inventoryDb.targetSnapshot();
  assert.deepStrictEqual(snapshot.items.map(item => item.stockId), ['B', 'D']);
  assert.strictEqual(inventoryDb.summary().needsUpdate, 2);

  inventoryDb.upsertInventory(inventory.filter(item => item.stockId !== 'D'), true);
  snapshot = inventoryDb.targetSnapshot();
  assert.deepStrictEqual(snapshot.items.map(item => item.stockId), ['B']);
  assert.strictEqual(inventoryDb.summary().needsUpdate, 1);

  console.log('PASS 전체 비교 결과 교체: 3개');
  console.log('PASS 선택 비교 부분 갱신: 나머지 2개 유지');
  console.log('PASS 판매 종료 대상 제거: 1개 유지');
  console.log('PASS 상단 요약/패널/API 조건 일치 및 stockId 중복 0개');
} finally {
  inventoryDb?.db.close();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
