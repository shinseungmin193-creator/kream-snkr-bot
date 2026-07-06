const { chromium } = require('playwright');

function parsePrice(text) {
  return Number(text.replace(/[^\d]/g, ''));
}

function calcBuyerPrice(option, price, usdRate = 1380) {
  const limitWon = 150 * usdRate;
  const isOverseas = option.includes('해외배송');

  let rate = 1.033;

  if (isOverseas && price >= limitWon) {
    rate = 1.133;
  }

  return Math.round(price * rate + 3000);
}

function parseSellBids(bodyText) {
  const start = bodyText.indexOf('옵션\n판매 희망가\n수량');
  const end = bodyText.indexOf('거래 내역 더보기', start);

  if (start === -1) return [];

  const target = bodyText
    .slice(start, end === -1 ? undefined : end)
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean)
    .slice(3);

  const bids = [];

  for (let i = 0; i < target.length; i += 3) {
    const option = target[i];
    const priceText = target[i + 1];
    const qtyText = target[i + 2];

    if (!option || !priceText || !qtyText) continue;
    if (!priceText.includes('원')) continue;

    const price = parsePrice(priceText);
    const qty = Number(qtyText.replace(/[^\d]/g, ''));

    bids.push({
      option,
      price,
      qty,
      buyerPrice: calcBuyerPrice(option, price),
    });
  }

  return bids;
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  const productPage = await context.newPage();

  await productPage.goto('https://kream.co.kr/products/873203', {
    waitUntil: 'domcontentloaded'
  });

  await productPage.waitForTimeout(5000);

  await productPage.getByRole('link', { name: '판매 입찰' }).click();
  await productPage.waitForTimeout(3000);

  const bodyText = await productPage.locator('body').innerText();

  const bids = parseSellBids(bodyText);

  console.log(JSON.stringify(bids, null, 2));

  const lowest = bids[0];

  console.log('최저 판매가:', lowest);
})();