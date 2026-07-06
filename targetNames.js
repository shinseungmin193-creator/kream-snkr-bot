const fs = require('fs');

const targets = JSON.parse(
  fs.readFileSync('update_targets.json', 'utf8')
);

console.log(`\n수정 대상 ${targets.length}개\n`);

targets.forEach((item, index) => {
  console.log(`${index + 1}. ${item.koreanName}`);
  console.log(`   옵션: ${item.option}`);
  console.log(`   현재가: ${item.myPrice.toLocaleString()}원`);
  console.log(`   최저가: ${item.lowestPrice.toLocaleString()}원`);
  console.log('');
});