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

const PRICE_COMPARE_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.PRICE_COMPARE_CONCURRENCY) || 4));

function seconds(milliseconds) {
  return (Math.max(0, milliseconds) / 1000).toFixed(2);
}

function isRateOrSecurityError(error) {
  return /\b(?:403|429)\b|ERR_HTTP_RESPONSE_CODE_FAILURE|captcha|보안|추가 인증|로그인 페이지/i.test(String(error?.message || error || ''));
}

function isTransientCompareError(error) {
  return /Timeout|ERR_(?:HTTP_RESPONSE_CODE_FAILURE|CONNECTION|NETWORK)|\b(?:403|429|502|503)\b|로딩|판매입찰|옵션 판매입찰/i.test(String(error?.message || error || ''));
}

async function waitForBidData(page, targetOption, timeout = 15000) {
  await page.waitForFunction(option => {
    const text = document.body?.innerText || '';
    const start = text.indexOf('옵션\n판매 희망가\n수량');
    if (start < 0) return false;
    const end = text.indexOf('거래 내역 더보기', start);
    const lines = text.slice(start, end < 0 ? undefined : end).split('\n').map(value => value.trim()).filter(Boolean);
    for (let index = 0; index < lines.length - 2; index += 1) {
      if (lines[index] !== option) continue;
      if (/\d/.test(lines[index + 1]) && /\d/.test(lines[index + 2])) return true;
    }
    return false;
  }, targetOption, { timeout });
}

function inspectSecurityPage(page) {
  return page.locator('body').innerText().then(text => {
    const url = page.url();
    if (/login|signin/i.test(url) || /CAPTCHA|캡차|추가 인증|보안 확인/i.test(text)) {
      throw new Error(`예상하지 못한 로그인/보안 페이지: ${url}`);
    }
  });
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
  const results = new Array(items.length);
  let targetCount = 0;
  let completedCount = 0;
  let desiredConcurrency = PRICE_COMPARE_CONCURRENCY;
  const bidCache = new Map();
  const networkRequests = new Set();
  const startedAt = Date.now();

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
  if (!context) throw new Error('연결된 KREAM 로그인 Chrome context가 없습니다.');
  console.log(`[속도 설정] 가격 비교 동시 처리: ${PRICE_COMPARE_CONCURRENCY}`);

  async function loadBidRows(page, item, productId, targetOption, workerId) {
    const navigationStartedAt = Date.now();
    const response = await page.goto(`https://kream.co.kr/products/${productId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    const navigationMs = Date.now() - navigationStartedAt;
    if (response && [403, 429].includes(response.status())) throw new Error(`HTTP ${response.status()} 상품 페이지 응답`);
    await inspectSecurityPage(page);

    const loadingStartedAt = Date.now();
    const saleBidLink = page.getByRole('link', { name: '판매 입찰' });
    await saleBidLink.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (await saleBidLink.isVisible().catch(() => false)) {
      await saleBidLink.click({ timeout: 5000 });
    }

    const optionSelect = page.locator('text=옵션 선택').last();
    await Promise.race([
      optionSelect.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {}),
      waitForBidData(page, targetOption, 10000).catch(() => {})
    ]);

    if (await optionSelect.isVisible().catch(() => false)) {
      await optionSelect.click({ force: true });
      const optionButton = page.getByRole('button', { name: targetOption, exact: true });
      await optionButton.waitFor({ state: 'visible', timeout: 10000 });
      await optionButton.click({ timeout: 5000 });
    }

    await waitForBidData(page, targetOption, 15000);
    const loadingMs = Date.now() - loadingStartedAt;
    const parsingStartedAt = Date.now();
    const text = await page.locator('body').innerText();
    const start = text.indexOf('옵션\n판매 희망가\n수량');
    const end = text.indexOf('거래 내역 더보기', start);
    if (start === -1) throw new Error('판매입찰 영역 못찾음');
    const lines = text.slice(start, end === -1 ? undefined : end).split('\n').map(value => value.trim()).filter(Boolean);
    const bidRows = getBidRows(lines, targetOption);
    if (bidRows.length === 0) throw new Error('옵션 판매입찰 못찾음');
    return { bidRows, navigationMs, loadingMs, parsingMs: Date.now() - parsingStartedAt, workerId };
  }

  async function compareItem(page, item, itemIndex, workerId, attempt = 1) {
    const productId = item.productCode.match(/\((\d+)\)/)?.[1];
    const targetOption = item.option;
    const cacheKey = `${productId}::${targetOption}`;
    const itemStartedAt = Date.now();
    if (!productId) throw new Error(`상품 ID를 찾을 수 없음: stockId=${item.stockId}`);

    console.log('\n==============================');
    console.log(`[가격비교 ${itemIndex + 1}/${items.length}] worker=${workerId}`);
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
      reportAutomationProgress({
        current: itemIndex,
        total: items.length,
        step: '최저가 조회',
        message: `${itemIndex + 1}/${items.length} · stockId ${item.stockId} 최저가 조회 중`,
        stockId: String(item.stockId || ''),
        productName: item.koreanName
      });
      const cached = bidCache.has(cacheKey);
      if (!cached) {
        const promise = loadBidRows(page, item, productId, targetOption, workerId).catch(error => {
          bidCache.delete(cacheKey);
          throw error;
        });
        bidCache.set(cacheKey, promise);
      }
      const loaded = await bidCache.get(cacheKey);
      const bidRows = loaded.bidRows;

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

      results[itemIndex] = result;

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

      console.log(`페이지 진입: ${seconds(loaded.navigationMs)}초`);
      console.log(`가격 데이터 로딩: ${seconds(loaded.loadingMs)}초${cached ? ' (실행 캐시)' : ''}`);
      console.log(`가격 파싱: ${seconds(loaded.parsingMs)}초`);
      console.log(`총: ${seconds(Date.now() - itemStartedAt)}초`);

    } catch (e) {
      console.log('실패:', e.message);

      if (attempt < 2 && isTransientCompareError(e)) {
        bidCache.delete(cacheKey);
        if (desiredConcurrency > 1) {
          const previous = desiredConcurrency;
          desiredConcurrency = Math.max(1, Math.floor(desiredConcurrency / 2));
          console.log(`[속도 조절] 가격 로딩 오류 감지 → 동시 처리 ${previous} → ${desiredConcurrency}`);
        }
        console.log(`[재시도] stockId=${item.stockId} 독립 조회 1회 재시도`);
        await page.goto('about:blank').catch(() => {});
        if (isRateOrSecurityError(e)) {
          console.log(`[대기] stockId=${item.stockId} KREAM 응답 정상화를 5초 대기`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        return compareItem(page, item, itemIndex, workerId, attempt + 1);
      }

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

      results[itemIndex] = errorResult;
      if (isRateOrSecurityError(e) && desiredConcurrency > 1) {
        const previous = desiredConcurrency;
        desiredConcurrency = Math.max(1, Math.floor(desiredConcurrency / 2));
        console.log(`[속도 조절] 요청 오류 감지 → 동시 처리 ${previous} → ${desiredConcurrency}`);
      }
    }

    fs.writeFileSync(
      outputFile,
      JSON.stringify(results.filter(Boolean), null, 2),
      'utf8'
    );

    fs.writeFileSync(
      'inventory_result.json',
      JSON.stringify(results.filter(Boolean), null, 2),
      'utf8'
    );
    completedCount += 1;
    reportAutomationProgress({
      current: completedCount,
      total: items.length,
      step: '가격 비교',
      message: `${completedCount}/${items.length} · stockId ${item.stockId} 가격 비교 완료`,
      stockId: String(item.stockId || ''),
      productName: item.koreanName
    });
    console.log(`${completedCount}/${items.length} 가격 비교 완료`);
  }

  let nextIndex = 0;
  async function worker(workerId) {
    const page = await context.newPage();
    page.on('response', response => {
      const request = response.request();
      if (!['xhr', 'fetch'].includes(request.resourceType())) return;
      const url = new URL(response.url());
      if (!/kream\.co\.kr$/i.test(url.hostname)) return;
      const signature = `${response.status()} ${request.method()} ${url.origin}${url.pathname}`;
      if (networkRequests.size < 20 && !networkRequests.has(signature)) {
        networkRequests.add(signature);
        console.log(`[가격 데이터 요청] ${signature}`);
      }
      if ([403, 429].includes(response.status()) && desiredConcurrency > 1) {
        const previous = desiredConcurrency;
        desiredConcurrency = Math.max(1, Math.floor(desiredConcurrency / 2));
        console.log(`[속도 조절] HTTP ${response.status()} 감지 → 동시 처리 ${previous} → ${desiredConcurrency}`);
      }
    });
    try {
      while (true) {
        while (workerId > desiredConcurrency && nextIndex < items.length) await new Promise(resolve => setTimeout(resolve, 250));
        const itemIndex = nextIndex++;
        if (itemIndex >= items.length) return;
        await compareItem(page, items[itemIndex], itemIndex, workerId);
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  await Promise.all(Array.from({ length: PRICE_COMPARE_CONCURRENCY }, (_, index) => worker(index + 1)));

  const elapsedMs = Date.now() - startedAt;

  console.log('\n==============================');
  console.log(`완료: ${outputFile} 생성`);
  console.log('inventory_result.json 호환 저장 완료');
  console.log(`실시간 수정대상 발견: ${targetCount}개`);
  console.log(`총 상품: ${items.length}`);
  console.log(`가격 비교: ${seconds(elapsedMs)}초`);
  console.log(`평균: ${items.length ? seconds(elapsedMs / items.length) : '0.00'}초/건`);
  console.log('==============================');
  // Disconnect this worker from the existing CDP session without closing the
  // user's logged-in Chrome. Otherwise the Node event loop remains alive and
  // the server never receives the child-process completion event.
  process.exit(0);
})();
