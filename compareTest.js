const { chromium } = require('playwright');
const fs = require('fs');

function parsePrice(text) {
  return Number(text.replace(/[^\d]/g, ''));
}

(async () => {
  const items = JSON.parse(fs.readFileSync('inventory_all.json', 'utf8'));

  // 여기 숫자 바꾸면 테스트 상품 변경
  const itemIndex = 1;
  const item = items[itemIndex];

  const productId = item.productCode.match(/\((\d+)\)/)?.[1];
  const targetOption = item.option;

  console.log('선택 index:', itemIndex);
  console.log('상품ID:', productId);
  console.log('상품명:', item.koreanName);
  console.log('내 옵션:', targetOption);
  console.log('내 판매가:', item.sellPrice);

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  const page = await context.newPage();

  await page.goto(`https://kream.co.kr/products/${productId}`, {
    waitUntil: 'domcontentloaded'
  });

  await page.waitForTimeout(4000);

  // 판매 입찰 탭 클릭
  await page.getByRole('link', { name: '판매 입찰' }).click();
  await page.waitForTimeout(1500);

  // 옵션 선택 클릭
  await page.locator('text=옵션 선택').last().click({ force: true });
  await page.waitForTimeout(1000);

  // 내 옵션 클릭
  await page
  .locator('.option_list, .select_list, [class*="option"], [class*="select"]')
  .getByText(targetOption, { exact: true })
  .last()
  .click({ force: true });  await page.waitForTimeout(2000);

  const text = await page.locator('body').innerText();

  const start = text.indexOf('옵션\n판매 희망가\n수량');
  const end = text.indexOf('거래 내역 더보기', start);

  if (start === -1) {
    console.log('판매 입찰 영역 못 찾음');
    await page.close();
    return;
  }

  const lines = text
    .slice(start, end === -1 ? undefined : end)
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);

  const optionIndex = lines.findIndex(x => x === targetOption);

  if (optionIndex === -1) {
    console.log('내 옵션 판매입찰 못 찾음');
    console.log(lines);
    await page.close();
    return;
  }

  const lowestPrice = parsePrice(lines[optionIndex + 1]);
  const qty = Number(lines[optionIndex + 2].replace(/[^\d]/g, ''));

  console.log({
    productId,
    koreanName: item.koreanName,
    myOption: targetOption,
    myPrice: item.sellPrice,
    lowestPrice,
    qty
  });

  await page.close();
})();