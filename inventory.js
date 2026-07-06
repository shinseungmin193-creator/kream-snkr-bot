const { chromium } = require('playwright');
const fs = require('fs');

function parseRow(text) {
  const lines = text.split('\n').map(v => v.trim()).filter(Boolean);

  return {
    stockId: lines[0] || '',
    status: lines[1] || '',
    productCode: lines[2] || '',
    englishName: lines[3] || '',
    koreanName: lines[4] || '',
    option: lines[5] || '',
    purchasePrice: lines[6] || '',
    sellPrice: lines[7] || '',
    totalQty: lines[8] || '',
    soldQty: lines[9] || '',
    remainQty: lines[10] || '',
    createdAt: lines[11] || '',
    updatedAt: lines[12] || '',
    raw: text
  };
}

function getFileSuffix(keyword) {
  const k = String(keyword || '').toLowerCase();

  if (k.includes('포켓몬') || k.includes('pokemon')) return 'pokemon';
  if (k.includes('원피스') || k.includes('onepiece') || k.includes('one piece')) return 'onepiece';

  return 'all';
}

async function readCurrentPage(page) {
  const rowTexts = await page.locator('div.Table_row__ZyONC').evaluateAll(rows =>
    rows.map(r => r.innerText.trim()).filter(Boolean)
  );

  return rowTexts.map(parseRow);
}

(async () => {
  const keyword = process.argv[2] || '포켓몬';
  const suffix = getFileSuffix(keyword);

  const inventoryFile =
    suffix === 'all'
      ? 'inventory_all.json'
      : `inventory_${suffix}.json`;

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  await page.goto('https://partner.kream.co.kr/business/ask-sales', {
    waitUntil: 'networkidle'
  });

  console.log('재고별 입찰관리 접속');
  console.log(`검색어: ${keyword}`);
  console.log(`저장 파일: ${inventoryFile}`);

  await page.waitForTimeout(2000);

  await page.getByText('재고 번호', { exact: true }).first().click({ force: true });
  await page.waitForTimeout(500);

  await page
    .locator('button')
    .filter({ hasText: '상품명' })
    .last()
    .click({ force: true });

  await page.waitForTimeout(500);

  await page.getByPlaceholder('검색어를 입력해주세요.').fill(keyword);
  await page.waitForTimeout(500);

  await page
    .locator('button')
    .filter({ hasText: '전체' })
    .last()
    .click({ force: true });

  await page.waitForTimeout(500);

  await page
    .locator('button')
    .filter({ hasText: '판매중' })
    .last()
    .click({ force: true });

  await page.waitForTimeout(500);

  await page
    .locator('button')
    .filter({ hasText: '검색' })
    .click({ force: true });

  console.log(`${keyword} 검색 완료`);

  await page.waitForTimeout(3000);

  let allItems = [];

  for (let pageNo = 1; pageNo <= 20; pageNo++) {
    console.log(`===== ${pageNo}페이지 =====`);

    const items = await readCurrentPage(page);

    console.log(`상품 수: ${items.length}`);

    allItems.push(...items);

    console.log(`누적: ${allItems.length}`);

    if (items.length < 10) break;

    const nextPage = page.getByRole('button', {
      name: String(pageNo + 1),
      exact: true
    });

    const exists = await nextPage.isVisible().catch(() => false);

    if (!exists) {
      console.log(`${pageNo + 1}페이지 버튼 없음`);
      break;
    }

    console.log(`${pageNo + 1}페이지 이동`);

    await nextPage.click({ force: true });
    await page.waitForTimeout(2000);
  }

  fs.writeFileSync(
    inventoryFile,
    JSON.stringify(allItems, null, 2),
    'utf8'
  );

  // 기존 기능 보호용: 기존 파일도 같이 저장
  fs.writeFileSync(
    'inventory_all.json',
    JSON.stringify(allItems, null, 2),
    'utf8'
  );

  console.log(`총 ${allItems.length}개 저장 완료`);
  console.log(`${inventoryFile} 생성 완료`);
  console.log('inventory_all.json 호환 저장 완료');

  await page.close();

  console.log('inventory.js 완료');
  process.exit(0);
})();