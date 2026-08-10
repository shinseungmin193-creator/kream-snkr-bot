const { chromium } = require('playwright');
const fs = require('fs');

function reportAutomationProgress(progress) {
  console.log('__AUTOMATION_PROGRESS__:' + JSON.stringify(progress));
}

function parsePrice(text) {
  return Number(String(text || '').replace(/[^\d]/g, ''));
}

function getFileSuffix(keyword) {
  const k = String(keyword || '').toLowerCase();

  if (k.includes('포켓몬') || k.includes('pokemon')) return 'pokemon';
  if (k.includes('원피스') || k.includes('onepiece') || k.includes('one piece')) return 'onepiece';

  return 'all';
}

function sendTargetFound(item) {
  console.log('__TARGET_FOUND__:' + JSON.stringify(item));
}

function getBidRows(lines, targetOption) {
  const rows = [];

  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i] !== targetOption) {
      continue;
    }

    const price = parsePrice(lines[i + 1]);
    const qty = parsePrice(lines[i + 2]);

    if (!price || !qty) {
      continue;
    }

    rows.push({
      option: targetOption,
      price,
      qty
    });
  }

  return rows;
}

function getPricePlan(myPrice, bidRows) {
  const prices = bidRows
    .map(row => row.price)
    .filter(price => price > 0);

  if (prices.length === 0) {
    return {
      lowestPrice: null,
      priceAboveMine: null,
      targetPrice: null,
      targetReason: '판매입찰 가격 없음'
    };
  }

  const lowestPrice = Math.min(...prices);

  if (myPrice > lowestPrice) {
    return {
      lowestPrice,
      priceAboveMine: lowestPrice,
      targetPrice: Math.max(lowestPrice - 1000, 1000),
      targetReason: '내 가격이 최저가보다 높음'
    };
  }

  const higherPrices = prices
    .filter(price => price > myPrice)
    .sort((a, b) => a - b);

  const priceAboveMine = higherPrices.length > 0 ? higherPrices[0] : null;

  if (!priceAboveMine) {
    return {
      lowestPrice,
      priceAboveMine: null,
      targetPrice: myPrice,
      targetReason: '내 위 판매입찰 없음'
    };
  }

  return {
    lowestPrice,
    priceAboveMine,
    targetPrice: Math.max(priceAboveMine - 1000, 1000),
    targetReason: '내 바로 위 판매입찰보다 1000원 낮춤'
  };
}

(async () => {
  const args = process.argv.slice(2);
  const keywordIndex = args.indexOf('--keyword');
  const keyword = keywordIndex >= 0
    ? String(args[keywordIndex + 1] || '')
    : String(args[0] && !args[0].startsWith('--') ? args[0] : '');
  const selectedIndex = args.indexOf('--stock-ids');
  const selectedStockIds = selectedIndex >= 0
    ? new Set(String(args[selectedIndex + 1] || '').split(',').map(value => value.trim()).filter(Boolean))
    : null;
  const suffix = getFileSuffix(keyword);

  const inputFile =
    suffix === 'all'
      ? 'inventory_all.json'
      : `inventory_${suffix}.json`;

  const outputFile =
    suffix === 'all'
      ? 'inventory_result.json'
      : `inventory_result_${suffix}.json`;

  const allItems = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const items = selectedStockIds
    ? allItems.filter(item => selectedStockIds.has(String(item.stockId || '')))
    : allItems;
  if (selectedStockIds && items.length !== selectedStockIds.size) {
    const found = new Set(items.map(item => String(item.stockId || '')));
    const missing = [...selectedStockIds].filter(stockId => !found.has(stockId));
    throw new Error(`선택 재고를 입력 파일에서 찾을 수 없음: ${missing.join(', ')}`);
  }
  const results = [];
  let targetCount = 0;

  console.log('==============================');
  console.log('KREAM COMPARE');
  console.log(`검색어: ${keyword || '기본값'}`);
  console.log(`읽기 파일: ${inputFile}`);
  console.log(`저장 파일: ${outputFile}`);
  if (selectedStockIds) console.log(`선택 재고 ${items.length}개만 가격 비교`);
  console.log('==============================');

  reportAutomationProgress({ current: 0, total: items.length, percent: 0, step: 'Chrome 연결', message: `가격 비교 대상 ${items.length}개 · Chrome 연결 중` });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const productId = item.productCode.match(/\((\d+)\)/)?.[1];
    const targetOption = item.option;

    console.log('\n==============================');
    console.log(`[${itemIndex + 1}/${items.length}]`);
    console.log(item.koreanName);
    console.log('옵션:', targetOption);
    reportAutomationProgress({
      current: itemIndex,
      total: items.length,
      step: 'KREAM 페이지 이동',
      message: `${itemIndex + 1}/${items.length} · stockId ${item.stockId} 페이지 이동 중`,
      stockId: String(item.stockId || ''),
      productName: item.koreanName
    });

    try {
      await page.goto(`https://kream.co.kr/products/${productId}`, {
        waitUntil: 'domcontentloaded'
      });

      await page.waitForTimeout(4000);

      await page.getByRole('link', { name: '판매 입찰' })
        .click({ timeout: 3000 })
        .catch(() => {});

      await page.waitForTimeout(1500);

      const optionSelect = page.locator('text=옵션 선택').last();

      if (await optionSelect.isVisible().catch(() => false)) {
        await optionSelect.click({ force: true });
        await page.waitForTimeout(1000);

        await page.getByRole('button', {
          name: targetOption,
          exact: true
        }).click({ timeout: 5000 });

        await page.waitForTimeout(2000);
      }

      reportAutomationProgress({
        current: itemIndex,
        total: items.length,
        step: '최저가 조회',
        message: `${itemIndex + 1}/${items.length} · stockId ${item.stockId} 최저가 조회 중`,
        stockId: String(item.stockId || ''),
        productName: item.koreanName
      });
      const text = await page.locator('body').innerText();

      const start = text.indexOf('옵션\n판매 희망가\n수량');
      const end = text.indexOf('거래 내역 더보기', start);

      if (start === -1) {
        throw new Error('판매입찰 영역 못찾음');
      }

      const lines = text
        .slice(start, end === -1 ? undefined : end)
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean);

      const bidRows = getBidRows(lines, targetOption);

      if (bidRows.length === 0) {
        throw new Error('옵션 판매입찰 못찾음');
      }

      const myPrice = parsePrice(item.sellPrice);
      const qty = bidRows[0].qty;

      const pricePlan = getPricePlan(myPrice, bidRows);

      const lowestPrice = pricePlan.lowestPrice;
      const priceAboveMine = pricePlan.priceAboveMine;
      const targetPrice = pricePlan.targetPrice;

      const isLowest = myPrice <= lowestPrice;
      const needsUpdate = Boolean(
        targetPrice &&
        targetPrice > 0 &&
        targetPrice !== myPrice
      );

      const result = {
        ...item,
        productId,
        myPrice,
        lowestPrice,
        priceAboveMine,
        targetPrice,
        qty,
        isLowest,
        needsUpdate,
        targetReason: pricePlan.targetReason,
        bidPrices: bidRows.map(row => row.price),
        error: null
      };

      console.log({
        myPrice,
        lowestPrice,
        priceAboveMine,
        targetPrice,
        qty,
        isLowest,
        needsUpdate,
        targetReason: result.targetReason
      });

      results.push(result);

      if (result.needsUpdate) {
        targetCount += 1;

        console.log(`❌ 수정대상 발견 (#${targetCount})`);
        console.log(`내가격: ${myPrice}`);
        console.log(`최저가: ${lowestPrice}`);
        console.log(`내 위 입찰가: ${priceAboveMine}`);
        console.log(`입력가: ${targetPrice}`);
        console.log(`사유: ${result.targetReason}`);

        sendTargetFound(result);
      }

    } catch (e) {
      console.log('실패:', e.message);

      const errorResult = {
        ...item,
        productId,
        myPrice: parsePrice(item.sellPrice),
        lowestPrice: null,
        priceAboveMine: null,
        targetPrice: null,
        qty: null,
        isLowest: false,
        needsUpdate: false,
        targetReason: null,
        bidPrices: [],
        error: e.message
      };

      results.push(errorResult);
    }

    fs.writeFileSync(
      outputFile,
      JSON.stringify(results, null, 2),
      'utf8'
    );

    fs.writeFileSync(
      'inventory_result.json',
      JSON.stringify(results, null, 2),
      'utf8'
    );

    reportAutomationProgress({
      current: itemIndex + 1,
      total: items.length,
      step: '가격 비교',
      message: `${itemIndex + 1}/${items.length} · stockId ${item.stockId} 가격 비교 완료`,
      stockId: String(item.stockId || ''),
      productName: item.koreanName
    });
    console.log(`${itemIndex + 1}/${items.length} 가격 비교 완료`);

    await page.waitForTimeout(1000);
  }

  await page.close();

  console.log('\n==============================');
  console.log(`완료: ${outputFile} 생성`);
  console.log('inventory_result.json 호환 저장 완료');
  console.log(`실시간 수정대상 발견: ${targetCount}개`);
  console.log('==============================');
  // Disconnect this worker from the existing CDP session without closing the
  // user's logged-in Chrome. Otherwise the Node event loop remains alive and
  // the server never receives the child-process completion event.
  process.exit(0);
})();
