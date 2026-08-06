const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'data', 'kream-bot.db');
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stockId TEXT NOT NULL UNIQUE,
  productId TEXT, productName TEXT NOT NULL DEFAULT '', optionName TEXT NOT NULL DEFAULT '',
  imageUrl TEXT, currentPrice INTEGER, lowestPrice INTEGER, floorPrice INTEGER,
  targetPrice INTEGER, totalQuantity INTEGER DEFAULT 0, remainingQuantity INTEGER DEFAULT 0,
  saleStatus TEXT NOT NULL DEFAULT 'ON_SALE', compareStatus TEXT NOT NULL DEFAULT 'NOT_COMPARED',
  updateStatus TEXT NOT NULL DEFAULT 'WAITING', updateError TEXT, category TEXT NOT NULL DEFAULT '',
  lastSyncedAt TEXT, lastComparedAt TEXT, lastUpdatedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_sale ON inventory_items(saleStatus);
CREATE INDEX IF NOT EXISTS idx_inventory_compare ON inventory_items(compareStatus);
CREATE TABLE IF NOT EXISTS sync_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, status TEXT NOT NULL,
  totalCount INTEGER DEFAULT 0, successCount INTEGER DEFAULT 0, failureCount INTEGER DEFAULT 0,
  message TEXT, createdAt TEXT NOT NULL
);`);

const now = () => new Date().toISOString();
const number = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^\d-]/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

function normalize(raw) {
  return {
    stockId: String(raw.stockId || '').trim(),
    productId: String(raw.productId || raw.productCode?.match(/\((\d+)\)/)?.[1] || raw.productCode || '').trim(),
    productName: String(raw.productName || raw.koreanName || raw.englishName || '').trim(),
    optionName: String(raw.optionName || raw.option || '').trim(), imageUrl: raw.imageUrl || null,
    currentPrice: number(raw.currentPrice ?? raw.myPrice ?? raw.sellPrice), lowestPrice: number(raw.lowestPrice),
    totalQuantity: number(raw.totalQuantity ?? raw.totalQty) || 0,
    remainingQuantity: number(raw.remainingQuantity ?? raw.remainQty ?? raw.qty) || 0,
    category: String(raw.category || '').trim()
  };
}

const upsert = db.prepare(`INSERT INTO inventory_items
 (stockId,productId,productName,optionName,imageUrl,currentPrice,lowestPrice,totalQuantity,remainingQuantity,saleStatus,category,lastSyncedAt,createdAt,updatedAt)
 VALUES (?,?,?,?,?,?,?,?,?,'ON_SALE',?,?,?,?)
 ON CONFLICT(stockId) DO UPDATE SET productId=excluded.productId,productName=excluded.productName,
 optionName=excluded.optionName,imageUrl=COALESCE(excluded.imageUrl,inventory_items.imageUrl),
 currentPrice=excluded.currentPrice,totalQuantity=excluded.totalQuantity,remainingQuantity=excluded.remainingQuantity,
 saleStatus='ON_SALE',category=CASE WHEN excluded.category='' THEN inventory_items.category ELSE excluded.category END,
 lastSyncedAt=excluded.lastSyncedAt,updatedAt=excluded.updatedAt`);

function upsertInventory(items, complete = true) {
  const timestamp = now(); const ids = []; let success = 0; let failure = 0;
  db.exec('BEGIN');
  try {
    for (const raw of items || []) {
      const item = normalize(raw);
      if (!item.stockId) { failure++; continue; }
      upsert.run(item.stockId,item.productId,item.productName,item.optionName,item.imageUrl,item.currentPrice,item.lowestPrice,
        item.totalQuantity,item.remainingQuantity,item.category,timestamp,timestamp,timestamp);
      ids.push(item.stockId); success++;
    }
    if (complete) {
      if (ids.length) {
        db.exec('CREATE TEMP TABLE IF NOT EXISTS synced_ids(stockId TEXT PRIMARY KEY); DELETE FROM synced_ids;');
        const put = db.prepare('INSERT OR IGNORE INTO synced_ids VALUES (?)'); ids.forEach(id => put.run(id));
        db.prepare("UPDATE inventory_items SET saleStatus='SOLD_OUT',compareStatus='SOLD_OUT',updatedAt=? WHERE saleStatus='ON_SALE' AND stockId NOT IN (SELECT stockId FROM synced_ids)").run(timestamp);
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { success, failure };
}

function listInventory(query = {}) {
  const page = Math.max(1, Number(query.page) || 1), pageSize = Math.min(100, Math.max(5, Number(query.pageSize) || 10));
  const clauses = [], params = {};
  if (query.search) { clauses.push('(productName LIKE :search OR optionName LIKE :search OR stockId LIKE :search)'); params.search=`%${query.search}%`; }
  if (query.status) { clauses.push('(saleStatus=:status OR compareStatus=:status OR updateStatus=:status)'); params.status=query.status; }
  if (query.category) { clauses.push('category=:category'); params.category=query.category; }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) count FROM inventory_items ${where}`).get(params).count;
  const items = db.prepare(`SELECT * FROM inventory_items ${where} ORDER BY id DESC LIMIT :limit OFFSET :offset`).all({...params,limit:pageSize,offset:(page-1)*pageSize});
  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total/pageSize)) };
}

function summary() {
  return db.prepare(`SELECT COUNT(CASE WHEN saleStatus='ON_SALE' THEN 1 END) totalActive,
    COUNT(CASE WHEN compareStatus='NEEDS_UPDATE' THEN 1 END) needsUpdate,
    COUNT(CASE WHEN compareStatus='FLOOR_REACHED' THEN 1 END) floorReached,
    COUNT(CASE WHEN compareStatus IN ('LOWEST','NO_FLOOR') THEN 1 END) lowestMaintained,
    COUNT(CASE WHEN saleStatus!='ON_SALE' THEN 1 END) soldOut,
    COUNT(CASE WHEN updateStatus='COMPLETED' AND date(lastUpdatedAt,'localtime')=date('now','localtime') THEN 1 END) updatedToday,
    MAX(lastSyncedAt) lastSyncedAt FROM inventory_items`).get();
}

const MAX_FLOOR_PRICE = 1_000_000_000;

function normalizeFloorPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.replace(/,/g, ''))) {
    throw new Error('하한가는 숫자만 입력할 수 있습니다.');
  }
  const floorPrice = Number(String(value).replace(/,/g, ''));
  if (!Number.isSafeInteger(floorPrice) || floorPrice <= 0) throw new Error('하한가는 0보다 큰 정수여야 합니다.');
  if (floorPrice > MAX_FLOOR_PRICE) throw new Error(`하한가는 ${MAX_FLOOR_PRICE.toLocaleString('ko-KR')}원 이하여야 합니다.`);
  return floorPrice;
}

function saveFloorPrices(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('저장할 하한가가 없습니다.');
  if (items.length > 1000) throw new Error('한 번에 최대 1,000개까지 저장할 수 있습니다.');

  const normalized = items.map(item => {
    const stockId = String(item?.stockId || '').trim();
    if (!stockId) throw new Error('stockId가 없는 항목이 있습니다.');
    return { stockId, floorPrice: normalizeFloorPrice(item.lowerPrice ?? item.floorPrice) };
  });
  if (new Set(normalized.map(item => item.stockId)).size !== normalized.length) throw new Error('중복된 stockId가 있습니다.');

  const exists = db.prepare('SELECT 1 FROM inventory_items WHERE stockId=?');
  const update = db.prepare('UPDATE inventory_items SET floorPrice=?,updatedAt=? WHERE stockId=?');
  const timestamp = now();
  db.exec('BEGIN');
  try {
    for (const item of normalized) {
      if (!exists.get(item.stockId)) throw new Error(`재고를 찾을 수 없습니다: ${item.stockId}`);
      update.run(item.floorPrice, timestamp, item.stockId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return normalized;
}

function saveFloorPrice(stockId, value) {
  return saveFloorPrices([{ stockId, floorPrice: value }])[0].floorPrice;
}

function applyComparison(results) {
  const stmt=db.prepare(`UPDATE inventory_items SET lowestPrice=?,targetPrice=?,compareStatus=?,lastComparedAt=?,updatedAt=? WHERE stockId=?`);
  const timestamp=now(); let targets=0, floors=0, failures=0;
  db.exec('BEGIN'); try {
    for (const raw of results || []) {
      const row=db.prepare('SELECT floorPrice FROM inventory_items WHERE stockId=?').get(String(raw.stockId||'')); if(!row) continue;
      const target=number(raw.targetPrice), lowest=number(raw.lowestPrice), floor=number(row.floorPrice);
      let status;
      if(raw.error){status='COMPARE_FAILED';failures++;}
      else if(floor && ((!target || target<floor) || (lowest && lowest<floor))){status='FLOOR_REACHED';floors++;}
      else if(raw.needsUpdate && target){status=floor?'NEEDS_UPDATE':'NO_FLOOR';targets++;}
      else status=floor?'LOWEST':'NO_FLOOR';
      stmt.run(lowest,target,status,timestamp,timestamp,String(raw.stockId));
    } db.exec('COMMIT');
  } catch(e){db.exec('ROLLBACK');throw e;} return {targets,floors,failures};
}

function targets(){ return db.prepare("SELECT * FROM inventory_items WHERE saleStatus='ON_SALE' AND compareStatus IN ('NEEDS_UPDATE','NO_FLOOR') AND targetPrice>0 AND targetPrice!=currentPrice ORDER BY id").all(); }
function markUpdate(stockId,status,error=null,newPrice=null){ db.prepare('UPDATE inventory_items SET updateStatus=?,updateError=?,currentPrice=COALESCE(?,currentPrice),lastUpdatedAt=?,updatedAt=? WHERE stockId=?').run(status,error,newPrice,status==='COMPLETED'?now():null,now(),stockId); }
function addHistory(kind,status,counts={},message=''){ db.prepare('INSERT INTO sync_history(kind,status,totalCount,successCount,failureCount,message,createdAt) VALUES(?,?,?,?,?,?,?)').run(kind,status,counts.total||0,counts.success||0,counts.failure||0,message,now()); }

module.exports={DB_PATH,db,upsertInventory,listInventory,summary,saveFloorPrice,saveFloorPrices,applyComparison,targets,markUpdate,addHistory,MAX_FLOOR_PRICE};
