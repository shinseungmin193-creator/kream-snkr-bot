const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  let page = context.pages().find(p => p.url().includes('partner.kream.co.kr'));

  if (!page) {
    page = await context.newPage();
    await page.goto('https://partner.kream.co.kr/seller');
  }

  await page.waitForTimeout(3000);

  const title = await page.title();
  const url = page.url();
  const text = await page.locator('body').innerText();

  console.log('제목:', title);
  console.log('URL:', url);
  console.log('본문 앞부분:');
  console.log(text.slice(0, 1000));

  await browser.close();
})();