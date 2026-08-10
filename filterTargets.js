const fs = require('fs');

function getFileSuffix(keyword) {
  const k = String(keyword || '').toLowerCase();

  if (k.includes('포켓몬') || k.includes('pokemon')) return 'pokemon';
  if (k.includes('원피스') || k.includes('onepiece') || k.includes('one piece')) return 'onepiece';

  return 'all';
}

const keyword = process.argv[2] || '';
const suffix = getFileSuffix(keyword);

const inputFile =
  suffix === 'all'
    ? 'inventory_result.json'
    : `inventory_result_${suffix}.json`;

const outputFile =
  suffix === 'all'
    ? 'update_targets.json'
    : `update_targets_${suffix}.json`;

console.log(`검색어: ${keyword || '기본값'}`);
console.log(`입력파일: ${inputFile}`);
console.log(`출력파일: ${outputFile}`);

if (!fs.existsSync(inputFile)) {
  console.log(`${inputFile} 없음`);
  process.exit(1);
}

const items = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

const targetsByStockId = new Map();

items.filter(item => {
  const myPrice = Number(item.myPrice || 0);
  const targetPrice = Number(item.targetPrice || 0);
  const needsUpdate = item.needsUpdate === true;

  return (
    needsUpdate &&
    myPrice > 0 &&
    targetPrice > 0 &&
    myPrice !== targetPrice
  );
}).forEach(item => {
  const stockId = String(item.stockId || '').trim();
  if (stockId) targetsByStockId.set(stockId, item);
});

const targets = [...targetsByStockId.values()];

fs.writeFileSync(
  outputFile,
  JSON.stringify(targets, null, 2),
  'utf8'
);

fs.writeFileSync(
  'update_targets.json',
  JSON.stringify(targets, null, 2),
  'utf8'
);

console.log(`전체: ${items.length}개`);
console.log(`수정대상: ${targets.length}개`);
console.log(`${outputFile} 생성 완료`);
console.log('update_targets.json 호환 저장 완료');
