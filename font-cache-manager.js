/**
 * =============================================================================
 * font-cache-manager.js
 * =============================================================================
 * ⚠️ 【現狀：暫時沒有呼叫端，屬於保留但未使用的模組】
 * 原本是給 PdfConverter 的 word-to-pdf（pdf-lib 手動排版）路徑用的
 * 內嵌字型來源。該路徑已改用 html-to-pdf-renderer.js（html2canvas
 * 螢幕截圖式渲染，直接吃瀏覽器/作業系統既有字型，不需要額外準備
 * 嵌入字型檔）取代，詳見 converters/PdfConverter.js 檔頭說明。
 * 這裡先保留模組本身，未來如果又有需要「嵌入特定字型檔」的場景
 * （例如要生成可反白選取文字、而不是截圖式的 PDF）可以再接回來，
 * 但接回來之前要先把下面提到的 FONT_URL 佔位網址換成真正部署好的
 * 字型檔位置。
 * =============================================================================
 */

/**
 * =============================================================================
 * font-cache-manager.js
 * =============================================================================
 * 【模組定位】
 * 負責中文字型檔案的 IndexedDB 快取管理，供 PdfConverter 在「PDF 轉
 * 圖片」時，於 Canvas 渲染含中文的 PDF 內容時，作為系統字型缺字的
 * fallback 字型來源，確保轉出來的圖片不會有中文字缺字的方塊。
 *
 * 【載入時機的設計決策 —— 懶載入而非頁面載入時就下載】
 * 原始規格書寫的是「載入網頁時，靜默檢查 IndexedDB」，字面上容易被
 * 理解成「一進頁面就要開始下載約 5.5MB 字型」。但本專案採用的是「懶載入」
 * 原則（跟 WorkerLifecycle 對 Worker 的處理方式一致）：只有當使用者
 * 真的要進行「文件轉檔」時，才會呼叫 ensureFontReady()，這裡才會去
 * 檢查/下載字型。理由：
 *   1. 大部分使用者可能只用圖片或影音轉檔，若一進頁面就強迫下載約 5.5MB，
 *      對這些使用者是不必要的頻寬浪費。
 *   2. IndexedDB 的「檢查」本身很快（本機讀取），不會有延遲問題，
 *      真正耗時的是「下載」，而下載這件事只在真正需要時才觸發，
 *      完全符合規格書「若快取命中則 0 秒讀取，不存在才顯示下載提示」
 *      這個核心行為要求，只是觸發的時間點改成「使用者真正需要用到
 *      字型的當下」而非「頁面一開啟」。
 * =============================================================================
 */

import { EventBus_instance } from './event-bus.js';

// -------------------------------------------------------------------------
// 常數設定
// -------------------------------------------------------------------------
const DB_NAME = 'font_cache';
const DB_VERSION = 1;
const STORE_NAME = 'fonts';
const RECORD_KEY = 'noto-sans-tc';

// 字型「內容版本號」：跟 IndexedDB 的 DB_VERSION（資料庫結構版本）
// 是兩個不同的概念——DB_VERSION 是給 indexedDB.open() 用來判斷要不要
// 觸發 onupgradeneeded 建立/升級資料表結構；FONT_CONTENT_VERSION
// 則是「這包字型檔案本身的版本」，若未來字型檔案更新（例如換了字型
// 供應商、修了字重問題），只需要調高這個數字，getCachedFont() 比對到
// 版本不符就會視為快取失效，自動重新下載，不需要使用者手動清瀏覽器
// 資料，也不需要調整 DB_VERSION（資料庫結構本身沒有變）。
const FONT_CONTENT_VERSION = 3;

// 字型檔案的下載來源。
// ⚠️ 這裡是一個「需要替換成實際部署路徑」的預留值——本專案是純前端
// 靜態網站，字型檔案應該跟 index.html 放在同一個 repo 內一起部署到
// GitHub Pages（例如 ./assets/fonts/NotoSansTC-Regular.otf），
// 或指向有 CORS 支援的公開 CDN。由於目前開發環境沒有網路存取權限
// 可以先行下載測試用字型檔並打包進專案，這裡先保留一個合理的相對
// 路徑當作預留位置，實際部署前務必替換成真正存在的字型檔案路徑。
const FONT_URL = './assets/fonts/NotoSansTC-Regular.ttf';

/**
 * -----------------------------------------------------------------------
 * openDatabase()
 * -----------------------------------------------------------------------
 * 用 Promise 包裝原生 indexedDB API（IndexedDB 原生介面是基於事件的
 * callback 風格，包成 Promise 才能搭配 async/await 使用，避免整個
 * 模組被回呼地獄淹沒）。
 * -----------------------------------------------------------------------
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // onupgradeneeded：只有在「資料庫第一次建立」或「DB_VERSION 數字
    // 被調高」時才會觸發，用來建立/調整物件儲存區（object store）的
    // 結構。這裡用 RECORD_KEY 當作 in-line key（record.key），
    // 不需要額外指定 keyPath 以外的索引，因為目前只會存這一筆字型
    // 快取紀錄，用不到複雜的查詢索引。
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * getCachedFont()
 * -------------------------------------------------------------------------
 * 嘗試從 IndexedDB 讀取已快取的字型紀錄，並比對版本號。
 * 回傳值：
 *   - 版本相符且確實有 blob 資料 → 回傳該 Blob
 *   - 沒有紀錄、版本不符、或讀取過程出錯 → 回傳 null
 *     （呼叫方 ensureFontReady() 收到 null 就會觸發重新下載）
 * -------------------------------------------------------------------------
 */
async function getCachedFont() {
  try {
    const db = await openDatabase();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();

    if (!record) return null;
    if (record.version !== FONT_CONTENT_VERSION) return null;
    if (!(record.blob instanceof Blob)) return null;

    return record.blob;
  } catch (err) {
    console.error('[FontCacheManager] 讀取快取時發生錯誤：', err);
    return null;
  }
}

/**
 * storeFontInCache(blob)
 * -------------------------------------------------------------------------
 * 把下載完成的字型 Blob 連同目前的版本號一起寫入 IndexedDB。
 * -------------------------------------------------------------------------
 */
async function storeFontInCache(blob) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put({ key: RECORD_KEY, version: FONT_CONTENT_VERSION, blob });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
}

/**
 * clearFontCache()
 * -------------------------------------------------------------------------
 * 依照規格書要求：「若寫入或讀取失敗，強制刪除舊快取並重新嘗試」，
 * 這裡提供一個乾淨的清除函式，供錯誤處理流程呼叫。就算刪除本身也
 * 失敗（例如 IndexedDB 整個不可用），也只記錄錯誤、不拋出例外，
 * 讓上層的重試邏輯還能繼續往下走（頂多是「這次重試沒有先清乾淨」，
 * 不應該讓整個字型下載流程因此完全中斷）。
 * -------------------------------------------------------------------------
 */
async function clearFontCache() {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(RECORD_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    db.close();
  } catch (err) {
    console.error('[FontCacheManager] 清除快取時發生錯誤（將繼續嘗試重新下載）：', err);
  }
}

/**
 * downloadFontWithProgress()
 * -------------------------------------------------------------------------
 * 下載字型檔案，並透過讀取 ReadableStream 的方式計算下載進度百分比，
 * 每次收到新的 chunk 就 emit 一次 'converter:font-status'
 * ({status:'progress', percent})，讓 ui-bridge.js 的
 * updateFontDownloadModalProgress() 能即時更新 Modal 裡的進度條與
 * 標題百分比文字。
 *
 * 為什麼不能直接用 `const blob = await (await fetch(url)).blob()`：
 * 那種寫法雖然簡短，但完全拿不到「下載到一半」的進度資訊，
 * blob() 是等整個回應都下載完才一次性回傳，不符合規格書要求的
 * 「下載中顯示百分比」需求，因此改用手動讀取 ReadableStream
 * 的方式，逐塊累加已下載的位元組數，除以 Content-Length 標頭
 * 取得的總大小，計算出即時百分比。
 * -------------------------------------------------------------------------
 */
async function downloadFontWithProgress() {
  const response = await fetch(FONT_URL);
  if (!response.ok) {
    throw new Error(`字型檔案下載失敗，HTTP 狀態碼：${response.status}`);
  }

  const contentLengthHeader = response.headers.get('Content-Length');
  const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    receivedBytes += value.length;

    // 只有在拿得到 Content-Length（伺服器有回傳這個標頭）時才能算出
    // 精確百分比；若拿不到（部分靜態主機設定下可能沒有這個標頭），
    // 就退而求其次，用「已下載位元組數」本身當作粗略的進度指標，
    // 至少能讓 UI 上的數字持續跳動、而不是完全沒有回應。
    const percent = totalBytes
      ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100))
      : Math.min(99, Math.round(receivedBytes / 1024 / 55)); // 粗估：約 5.5MB 對應到接近 100 的概略換算

    EventBus_instance.emit('converter:font-status', { status: 'progress', percent });
  }

  return new Blob(chunks);
}

/**
 * ensureFontReady()
 * -------------------------------------------------------------------------
 * 對外唯一入口，由 PdfConverter 在開始處理「PDF 轉圖片」任務前呼叫
 * （見 converters/PdfConverter.js）。完整流程：
 *
 *   1. 先查快取：命中且版本相符 → emit {status:'cached'}（規格書要求
 *      「0 秒直接讀取，不顯示任何提示」，ui-bridge.js 收到 'cached'
 *      時也確實不會跳出任何 Modal），直接回傳 Blob。
 *   2. 未命中 → emit {status:'downloading', percent:0} 讓 Modal 出現，
 *      呼叫 downloadFontWithProgress() 邊下載邊回報進度。
 *   3. 下載成功 → 寫入快取 → emit {status:'ready'} → 回傳 Blob。
 *   4. 下載或寫入過程中任何一步失敗 → 呼叫 clearFontCache() 強制清除
 *      舊快取 → 重新嘗試一次完整流程（下載 + 寫入）。
 *   5. 重試後仍然失敗 → emit {status:'error'} → 回傳 null。
 *      呼叫方（PdfConverter）收到 null 時應該要能「優雅降級」：
 *      改用瀏覽器/系統既有的預設字型繼續轉檔（可能會有缺字風險，
 *      但至少不會讓整個轉檔功能完全卡死），這部分的 fallback 邏輯
 *      屬於 PdfConverter 的職責，本模組只負責誠實回報「拿不到字型」
 *      這個事實。
 * -------------------------------------------------------------------------
 */
export async function ensureFontReady() {
  const cachedBlob = await getCachedFont();
  if (cachedBlob) {
    EventBus_instance.emit('converter:font-status', { status: 'cached' });
    return cachedBlob;
  }

  return attemptDownloadAndCache(/* isRetry */ false);
}

/**
 * attemptDownloadAndCache(isRetry)
 * -------------------------------------------------------------------------
 * 把「下載 → 寫入快取」包成一個可重試的內部函式，isRetry 參數純粹
 * 用於區隔 console 訊息，方便開發階段從 Console 判斷目前是第一次
 * 嘗試還是清除快取後的重試。
 * -------------------------------------------------------------------------
 */
async function attemptDownloadAndCache(isRetry) {
  try {
    EventBus_instance.emit('converter:font-status', { status: 'downloading', percent: 0 });

    const blob = await downloadFontWithProgress();
    await storeFontInCache(blob);

    EventBus_instance.emit('converter:font-status', { status: 'ready' });
    return blob;
  } catch (err) {
    console.error(
      `[FontCacheManager] 字型下載或寫入快取失敗（${isRetry ? '重試' : '首次嘗試'}）：`,
      err
    );

    if (isRetry) {
      // 已經是重試過的第二次失敗，不再繼續嘗試，誠實回報錯誤。
      EventBus_instance.emit('converter:font-status', { status: 'error' });
      return null;
    }

    // 第一次失敗：依規格書要求，強制刪除舊快取後重新嘗試一次。
    await clearFontCache();
    return attemptDownloadAndCache(/* isRetry */ true);
  }
}
