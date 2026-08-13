/**
 * =============================================================================
 * DeviceProfiler.js
 * =============================================================================
 * 【模組定位】
 * 這是整個 converter-core 架構中最底層、最優先執行的模組。
 * 所有其他模組（WorkerLifecycle、ProgressGuard、各 Converter）在真正開始
 * 轉檔之前，都需要先讀取這裡算出來的「裝置能力剖繪（DeviceProfile）」，
 * 才能決定：
 *   - 要不要直接封鎖某個功能（例如行動端封鎖影音）
 *   - 要套用哪一組檔案大小限制（Chromium 柔性 / Safari 硬性 / 行動端更嚴格）
 *   - Web Worker 建立前要不要先跳記憶體風險警告
 *
 * 【與 UI 的溝通方式】
 * 依照架構規則「核心邏輯嚴禁直接操作 DOM」，本模組不會出現任何
 * document.getElementById / querySelector 之類的呼叫。
 * 唯一對外溝通的方式是 EventBus_instance.emit(name, detail)，
 * 由 ui-bridge.js 監聽對應事件名稱後自行決定如何呈現。
 *
 * 【第一階段重構已完成】
 * 本模組已全面改用 EventBus_instance.emit() 廣播事件，不再直接呼叫
 * document.dispatchEvent。事件名稱與 payload 結構完全沒有變動，
 * 因此不影響既有的事件消費方。ui-bridge.js 現在也已經全面改用
 * EventBus_instance.on() 監聽（第二階段重構已完成），過渡期使用的
 * bridgeToDom() 轉發層已經整段移除，core 與 UI 之間現在是單純的
 * EventBus 直接溝通，不再經過 DOM CustomEvent 這層轉發。
 * =============================================================================
 */

// 引入 EventBus 全域單例：本模組所有對外廣播一律透過
// EventBus_instance.emit()，不再依賴 document 這個 DOM/BOM 全域物件，
// 讓核心邏輯未來搬進 Web Worker 或 Node.js 環境測試時也能正常運作。
import { EventBus_instance } from './event-bus.js';

// ------------------------------------------------------------------
// 對外事件名稱：集中定義成常數，避免字串打錯字造成 ui-bridge.js
// 監聽不到事件卻毫無錯誤訊息的「靜默失敗」情況。
// ------------------------------------------------------------------
export const DEVICE_PROFILER_EVENTS = {
  // 裝置剖繪完成時觸發，detail 為完整的 DeviceProfile 物件
  READY: 'converter:device-ready',
  // 跨域隔離狀態變化時觸發（例如 SW 剛接管、即將重新整理頁面）
  ISOLATION_STATUS: 'converter:isolation-status',
  // 記憶體風險評估結果（在使用者選擇檔案後，由 Orchestrator 呼叫
  // evaluateMemoryRisk() 時觸發，detail 包含是否超標、建議文案用的原始數字）
  MEMORY_RISK: 'converter:memory-risk',
};

// ------------------------------------------------------------------
// 各種硬性 / 柔性限制的數值常數。
// 全部集中寫在檔案最上方，方便之後如果要調整門檻值（例如未來 FFmpeg.wasm
// 效能改善後想放寬 Safari 限制），只需要改這裡幾個數字，不用去下面的
// 判斷邏輯裡面翻找魔術數字。
// ------------------------------------------------------------------
const LIMITS = {
  // Chromium（Chrome / Edge）桌面版：柔性提醒門檻，超過僅警告仍可繼續
  CHROMIUM_VIDEO_SOFT_WARNING_MB: 300,
  // Safari (Mac) 桌面版：半強硬限制，超過直接阻擋轉檔
  SAFARI_VIDEO_HARD_BLOCK_MB: 150,
  // 行動端／平板：僅開放小型文件轉檔的上限
  MOBILE_DOCUMENT_MAX_MB: 5,
  // navigator.deviceMemory 不支援時的保守預設值（多數桌機至少有 4GB）
  DEFAULT_DEVICE_MEMORY_GB: 4,
  // 記憶體風險評估公式的係數：裝置記憶體(GB) * 係數 < 檔案大小(GB) 視為風險
  // 例如 4GB 裝置：4 * 0.3 = 1.2GB，超過 1.2GB 的檔案就會被判定風險偏高。
  // 之所以只用 0.3（而非 0.5 或更高），是因為瀏覽器分頁本身、Wasm
  // runtime、以及轉檔過程中同時存在「原始檔案 + 解碼後的中間產物 + 輸出
  // 結果」三份資料在記憶體中，實際可用比例遠低於裝置總記憶體。
  MEMORY_RISK_RATIO: 0.3,
};

const MB = 1024 * 1024;

/**
 * -----------------------------------------------------------------------
 * detectTouchSupport()
 * -----------------------------------------------------------------------
 * 判斷條件 A：裝置是否支援觸控點。
 *
 * 為什麼要兩個條件用 || 連接：
 * - 'ontouchstart' in window：多數行動瀏覽器（含部分桌面觸控螢幕筆電）
 *   會實作這個事件，是最廣泛相容的偵測方式。
 * - navigator.maxTouchPoints > 0：部分新版瀏覽器（尤其是 Windows 觸控筆電
 *   使用 Edge/Chrome）不會觸發 ontouchstart，但會正確回報 maxTouchPoints，
 *   用這個當作備援判斷可以補足前者的偵測死角。
 *
 * 注意：這裡只判斷「有沒有觸控能力」，不能單獨拿來判斷是不是手機/平板，
 * 因為很多 PC 筆電、觸控螢幕一體機也支援觸控，所以規格書才會要求
 * 「同時滿足」觸控 + 行動特徵兩個條件，而不是只看觸控。
 * -----------------------------------------------------------------------
 */
function detectTouchSupport() {
  const hasTouchEvent = 'ontouchstart' in window;
  const hasTouchPoints = navigator.maxTouchPoints > 0;
  return hasTouchEvent || hasTouchPoints;
}

/**
 * -----------------------------------------------------------------------
 * detectMobileFeature()
 * -----------------------------------------------------------------------
 * 判斷條件 B：是否具備「行動端特徵」。
 * 依規格書要求，只要滿足以下任一項即算符合：
 *   1. 螢幕寬度 < 1024px（用 window.innerWidth，而非 screen.width，
 *      因為 innerWidth 反映的是「當前可視區域」，在分割視窗、
 *      開發者工具開啟等情境下更準確；且已在 <head> 設定正確的
 *      viewport meta，這裡的數值才具參考意義）。
 *   2. navigator.userAgent 包含 Android / iPhone / iPad / Mobile 等關鍵字。
 *
 * 為什麼還要判斷 UA 關鍵字，而不是只看寬度：
 * 使用者可能把桌面瀏覽器視窗縮得很窄（例如疊在旁邊參考文件），
 * 此時寬度雖然 < 1024px，但實際上是桌面等級的硬體與記憶體，
 * 不應該被誤判為行動裝置而被鎖死影音功能。
 * 但規格書明確要求「螢幕寬度 或 UA 關鍵字」任一滿足即可，
 * 因此仍完整依照規格實作 OR 邏輯，並在下方詳細記錄這個已知的
 * 邊界案例（縮小視窗的桌面瀏覽器）供未來調整參考。
 * -----------------------------------------------------------------------
 */
function detectMobileFeature() {
  const isNarrowViewport = window.innerWidth < 1024;

  // 關鍵字比對統一轉小寫，避免大小寫差異（雖然實務上 UA 字串大小寫固定，
  // 但轉小寫可以防禦未來瀏覽器 UA 格式變動）。
  const ua = navigator.userAgent.toLowerCase();
  const mobileKeywords = ['android', 'iphone', 'ipad', 'mobile'];
  const matchesMobileKeyword = mobileKeywords.some((keyword) => ua.includes(keyword));

  return isNarrowViewport || matchesMobileKeyword;
}

/**
 * -----------------------------------------------------------------------
 * detectIsMobileOrTablet()
 * -----------------------------------------------------------------------
 * 規格書要求的最終判定：觸控 AND 行動特徵，兩者「同時滿足」才視為
 * 手機或平板。這個雙重判定可以避免：
 *   - 誤判觸控筆電為手機（觸控成立但行動特徵不成立）
 *   - 誤判縮小視窗的桌機為手機（行動特徵可能因寬度成立，但沒有觸控）
 * 只有兩者都成立，才是真正的手機/平板使用情境。
 * -----------------------------------------------------------------------
 */
function detectIsMobileOrTablet() {
  return detectTouchSupport() && detectMobileFeature();
}

/**
 * -----------------------------------------------------------------------
 * detectBrowserEngine()
 * -----------------------------------------------------------------------
 * 判斷目前瀏覽器屬於 Chromium 系（Chrome / Edge / Opera 等）
 * 或是 Safari（僅限 Mac / iOS 的 WebKit 原生瀏覽器）。
 *
 * UA 判斷的技術難點：
 * Chrome 的 UserAgent 字串裡「本身就包含 Safari」這個詞
 * （因為歷史因素，Chrome 當初偽裝成 Safari 以相容舊版網站的 UA 嗅探），
 * 例如：
 *   Chrome UA 範例：Mozilla/5.0 ... AppleWebKit/537.36 (KHTML, like Gecko)
 *                   Chrome/120.0.0.0 Safari/537.36
 * 因此「判斷是否為 Safari」絕對不能只檢查字串裡有沒有 "Safari"，
 * 必須反過來：先排除掉所有 Chromium 系瀏覽器的關鍵字
 * （Chrome、Chromium、Edg 這是新版 Edge 的縮寫、OPR 是 Opera 的縮寫），
 * 排除後如果字串中仍然包含 "Safari"，才能真正判定為 Safari 本尊。
 * -----------------------------------------------------------------------
 */
function detectBrowserEngine() {
  const ua = navigator.userAgent;

  // 只要符合任一 Chromium 系關鍵字，就直接判定為 Chromium 系瀏覽器。
  // 注意 "Edg/" 特意加上斜線，是為了避免誤判到舊版 Edge (EdgeHTML 引擎，
  // 字串為 "Edge/")，新版 Edge (Chromium 核心) 的字串固定是 "Edg/"。
  const isChromium = /Chrome|Chromium|Edg\/|OPR\//.test(ua);

  // 只有「不是 Chromium 系」且「UA 內確實含有 Safari 字樣」時，
  // 才視為真正的 Safari 瀏覽器。
  const isSafari = !isChromium && /Safari/.test(ua);

  // 是否為 Mac 平台，用來搭配規格書「Safari (Mac)」的描述
  // （iOS 上的 Safari 因為前面 isMobileOrTablet 已經會判定為行動裝置，
  // 並直接封鎖影音功能，所以這裡的 isSafari 主要適用情境會是 Mac 桌面版）。
  const isMacPlatform = /Mac/.test(navigator.platform || '') || /Macintosh/.test(ua);

  return {
    isChromium,
    isSafari,
    isMacPlatform,
    // 提供原始 UA 字串方便除錯或未來擴充其他瀏覽器的判斷
    rawUserAgent: ua,
  };
}

/**
 * -----------------------------------------------------------------------
 * evaluateDeviceMemory()
 * -----------------------------------------------------------------------
 * 讀取 navigator.deviceMemory（單位為 GB，且瀏覽器只會回傳概略值，
 * 例如 0.25 / 0.5 / 1 / 2 / 4 / 8，並非精確數字，是刻意模糊化以保護隱私）。
 *
 * 此 API 目前僅 Chromium 系瀏覽器支援，Safari 完全不支援，
 * 因此「不支援時」一律 fallback 為規格書要求的預設 4GB，
 * 並且額外標記 isEstimated: true，讓 ui-bridge.js 或未來的
 * 記憶體警告文案可以視情況加註「（估計值）」字樣。
 * -----------------------------------------------------------------------
 */
function evaluateDeviceMemory() {
  const supported = typeof navigator.deviceMemory === 'number';
  const memoryGB = supported ? navigator.deviceMemory : LIMITS.DEFAULT_DEVICE_MEMORY_GB;

  return {
    memoryGB,
    isEstimated: !supported,
  };
}

/**
 * -----------------------------------------------------------------------
 * detectCrossOriginIsolation()
 * -----------------------------------------------------------------------
 * 檢查目前頁面是否處於跨域隔離狀態（window.crossOriginIsolated）。
 * 這個布林值只有在 COOP/COEP 標頭（或 coi-serviceworker.js 模擬的標頭）
 * 生效「之後」的頁面載入才會是 true —— 也就是說，Service Worker
 * 第一次安裝時，往往需要頁面「重新整理一次」才會讓 crossOriginIsolated
 * 變成 true（這是 coi-serviceworker.js 官方方案的已知行為：初次安裝時
 * 它會自動觸發一次 location.reload()）。
 *
 * 本函式的職責只有「偵測與回報現況」，不負責觸發真正的重新整理動作
 * （那是 coi-serviceworker.js 本身的內部邏輯），但我們用
 * sessionStorage 記錄「這個分頁是否已經重新整理過一次」，
 * 藉此判斷目前 false 的原因是：
 *   (a) 'reloading'：SW 剛裝上、正準備/正在重新整理，屬於正常過渡狀態
 *   (b) 'unavailable'：已經重新整理過仍然是 false，代表這個瀏覽器環境
 *       真的無法支援跨域隔離（例如 SW 註冊失敗、或瀏覽器完全不支援），
 *       此時應該由 ui-bridge.js 顯示「影音轉檔功能可能無法使用」的提示，
 *       而不是讓使用者傻等一個永遠不會發生的自動重新整理。
 *
 * sessionStorage 的 key 特意帶上專案專屬前綴，避免和同網域下其他工具
 * 的 sessionStorage 使用情境互相污染。
 * -----------------------------------------------------------------------
 */
function detectCrossOriginIsolation() {
  const RELOAD_FLAG_KEY = 'converter-tool:coi-reload-attempted';

  const isIsolated = window.crossOriginIsolated === true;

  if (isIsolated) {
    // 已經成功隔離，狀態正常，清掉重整標記避免影響下次全新分頁的判斷。
    try {
      sessionStorage.removeItem(RELOAD_FLAG_KEY);
    } catch (err) {
      // sessionStorage 在極少數環境（如隱私模式下部分瀏覽器）可能拋出例外，
      // 這裡不影響主流程，僅記錄警告即可。
      console.warn('[DeviceProfiler] 無法存取 sessionStorage：', err);
    }
    return { status: 'isolated', isIsolated: true };
  }

  // 尚未隔離：判斷這個分頁是否已經嘗試過重新整理一次。
  let hasAttemptedReload = false;
  try {
    hasAttemptedReload = sessionStorage.getItem(RELOAD_FLAG_KEY) === '1';
    if (!hasAttemptedReload) {
      sessionStorage.setItem(RELOAD_FLAG_KEY, '1');
    }
  } catch (err) {
    console.warn('[DeviceProfiler] 無法存取 sessionStorage，視為已重整過以避免無限迴圈：', err);
    hasAttemptedReload = true;
  }

  if (!hasAttemptedReload) {
    // 第一次偵測到未隔離：合理懷疑是 coi-serviceworker.js 剛註冊、
    // 即將自動重整頁面的正常過渡期，回報 'reloading' 讓 UI 可以選擇
    // 顯示一個短暫的載入提示，而不是立刻顯示「功能無法使用」的錯誤。
    return { status: 'reloading', isIsolated: false };
  }

  // 已經重整過仍然不是隔離狀態：判定為此環境確實無法支援。
  return { status: 'unavailable', isIsolated: false };
}

/**
 * -----------------------------------------------------------------------
 * resolveVideoLimit(profile)
 * -----------------------------------------------------------------------
 * 依照「瀏覽器與平台限制矩陣」，把裝置剖繪轉換成明確的影片轉檔限制規則。
 * 回傳的 mode 有三種：
 *   - 'blocked'      → 行動端：功能整個不開放
 *   - 'hard-limit'   → Safari：超過門檻直接擋下，無法繼續
 *   - 'soft-warning' → Chromium：超過門檻僅警告，使用者仍可繼續
 *
 * 特別注意：這裡只回傳「規則」，並不實際去比對某個檔案的大小
 * （檔案大小要等使用者真的選了檔案之後，由 Orchestrator 呼叫
 * checkVideoFileAgainstLimit() 才能判斷），這樣設計可以讓
 * DeviceProfiler 在頁面載入的當下就先算好規則、廣播給 UI 顯示提示文字，
 * 不需要等使用者選檔案才知道限制是什麼。
 * -----------------------------------------------------------------------
 */
function resolveVideoLimit(profile) {
  if (profile.isMobileOrTablet) {
    return {
      mode: 'blocked',
      maxSizeMB: 0,
      message: '手機與平板裝置不支援影音轉檔功能，請改用桌面版瀏覽器。',
    };
  }

  if (profile.browser.isSafari) {
    return {
      mode: 'hard-limit',
      maxSizeMB: LIMITS.SAFARI_VIDEO_HARD_BLOCK_MB,
      message: `由於 Safari 瀏覽器底層限制，大檔案轉檔請改用 Chrome 或 Edge 瀏覽器（上限 ${LIMITS.SAFARI_VIDEO_HARD_BLOCK_MB}MB）。`,
    };
  }

  // 預設歸類為 Chromium 系（含未來可能出現、UA 判斷落在此分支的其他瀏覽器），
  // 採用柔性提醒，不阻擋操作。
  return {
    mode: 'soft-warning',
    maxSizeMB: LIMITS.CHROMIUM_VIDEO_SOFT_WARNING_MB,
    message: `此影片檔案較大（超過 ${LIMITS.CHROMIUM_VIDEO_SOFT_WARNING_MB}MB），轉檔可能需要較長時間，是否仍要繼續？`,
  };
}

/**
 * -----------------------------------------------------------------------
 * resolveDocumentLimit(profile)
 * -----------------------------------------------------------------------
 * 文件轉檔（PDF 轉圖片 / Word 轉 PDF）在行動端有額外限制：
 * 僅開放 5MB 以內的小型文件，桌面版則不設限（沿用記憶體風險評估機制
 * 作為唯一的把關依據，不另外設固定上限）。
 * -----------------------------------------------------------------------
 */
function resolveDocumentLimit(profile) {
  if (profile.isMobileOrTablet) {
    return {
      mode: 'hard-limit',
      maxSizeMB: LIMITS.MOBILE_DOCUMENT_MAX_MB,
      message: `行動裝置僅支援 ${LIMITS.MOBILE_DOCUMENT_MAX_MB}MB 以內的小型文件轉檔。`,
    };
  }

  return {
    mode: 'unrestricted',
    maxSizeMB: null,
    message: null,
  };
}

/**
 * -----------------------------------------------------------------------
 * evaluateMemoryRisk(fileSizeBytes, profile)
 * -----------------------------------------------------------------------
 * 對外公開的記憶體風險評估函式，會在使用者「選定檔案、準備開始轉檔前」
 * 由 ConverterOrchestrator 呼叫。
 *
 * 判斷公式（依規格書）：
 *   裝置記憶體(GB) * MEMORY_RISK_RATIO < 檔案大小(GB) → 判定風險偏高
 *
 * 呼叫後會直接 dispatch 'converter:memory-risk' 事件，讓 ui-bridge.js
 * 決定是否要跳出「記憶體不足」的 Modal；同時也把結果 return 回去，
 * 讓 Orchestrator 可以同步用結果決定「要不要在跳出 Modal 的同時，
 * 暫停等待使用者確認」，不需要額外再監聽一次事件。
 * -----------------------------------------------------------------------
 */
export function evaluateMemoryRisk(fileSizeBytes, profile) {
  const fileSizeGB = fileSizeBytes / MB / 1024;
  const memoryGB = profile.memory.memoryGB;
  const isRisky = memoryGB * LIMITS.MEMORY_RISK_RATIO < fileSizeGB;

  const detail = {
    isRisky,
    memoryGB,
    isMemoryEstimated: profile.memory.isEstimated,
    fileSizeMB: Math.round((fileSizeBytes / MB) * 10) / 10,
    thresholdMB: Math.round(memoryGB * LIMITS.MEMORY_RISK_RATIO * 1024 * 10) / 10,
  };

  // 🔄 抽換處：改用 EventBus 發送，不再直接依賴 document 這個 DOM 物件。
  EventBus_instance.emit(DEVICE_PROFILER_EVENTS.MEMORY_RISK, detail);

  return detail;
}

/**
 * -----------------------------------------------------------------------
 * checkVideoFileAgainstLimit(fileSizeBytes, videoLimit)
 * -----------------------------------------------------------------------
 * 輔助函式：拿使用者實際選擇的影片檔案大小，去比對 resolveVideoLimit()
 * 算出來的規則，回傳這次選檔應該採取的動作。
 * 回傳值 action 有三種：
 *   - 'proceed'       → 在限制內，直接放行
 *   - 'warn-continue' → Chromium 柔性提醒，UI 顯示警告文字但按鈕仍可點擊
 *   - 'block'         → Safari 硬性限制或行動端已直接封鎖，必須阻擋
 * -----------------------------------------------------------------------
 */
export function checkVideoFileAgainstLimit(fileSizeBytes, videoLimit) {
  const fileSizeMB = fileSizeBytes / MB;

  if (videoLimit.mode === 'blocked') {
    return { action: 'block', message: videoLimit.message };
  }

  if (videoLimit.mode === 'hard-limit') {
    if (fileSizeMB > videoLimit.maxSizeMB) {
      return { action: 'block', message: videoLimit.message };
    }
    return { action: 'proceed', message: null };
  }

  // soft-warning 模式
  if (fileSizeMB > videoLimit.maxSizeMB) {
    return { action: 'warn-continue', message: videoLimit.message };
  }
  return { action: 'proceed', message: null };
}

/**
 * =============================================================================
 * initDeviceProfiler()
 * =============================================================================
 * 對外主要進入點。ConverterOrchestrator 在初始化流程最一開始就會呼叫這支
 * 函式（順序上要早於任何 Worker 建立或 IndexedDB 存取），執行流程：
 *   1. 組出完整的 DeviceProfile 物件
 *   2. 廣播 'converter:device-ready' 事件，讓 ui-bridge.js 更新
 *      capability-banner、鎖定/解鎖分頁按鈕等
 *   3. 廣播 'converter:isolation-status' 事件，讓 ui-bridge.js 決定
 *      要不要顯示「正在準備跨域隔離環境...」之類的過渡提示
 *   4. 回傳 profile 物件本身，供其他核心模組（非 UI 層）直接引用，
 *      不需要每個模組都重新監聽一次事件才能拿到資料。
 * =============================================================================
 */
export function initDeviceProfiler() {
  const isMobileOrTablet = detectIsMobileOrTablet();
  const browser = detectBrowserEngine();
  const memory = evaluateDeviceMemory();
  const isolation = detectCrossOriginIsolation();

  const profile = {
    isMobileOrTablet,
    browser,
    memory,
    isolation,
  };

  // 限制規則需要依賴上面已經組好的 profile，因此在這裡才計算，
  // 並且直接掛在 profile 物件上，方便其他模組一次拿到完整資訊。
  profile.videoLimit = resolveVideoLimit(profile);
  profile.documentLimit = resolveDocumentLimit(profile);

  // ---- 🔄 抽換處：廣播主要剖繪結果，改用 EventBus 發送 ----
  EventBus_instance.emit(DEVICE_PROFILER_EVENTS.READY, profile);

  // ---- 🔄 抽換處：廣播跨域隔離現況，改用 EventBus 發送 ----
  // （獨立事件，方便 ui-bridge.js 只針對這件事做輕量提示）
  EventBus_instance.emit(DEVICE_PROFILER_EVENTS.ISOLATION_STATUS, isolation);

  // 額外的 console 輸出僅供開發除錯，正式環境可視需要移除或改用
  // 條件式 debug flag 包起來。
  console.info('[DeviceProfiler] 裝置剖繪完成：', profile);

  return profile;
}
