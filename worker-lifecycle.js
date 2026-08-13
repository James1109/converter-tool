/**
 * =============================================================================
 * worker-lifecycle.js
 * =============================================================================
 * 【模組定位】
 * 統一管理專案中所有 Web Worker 的「建立」「使用」「銷毀」策略，
 * 是唯一被允許呼叫 `new Worker(...)` 的地方——各個 Converter
 * （ImageConverter / PdfConverter / VideoConverter）都必須透過本模組
 * 取得 Worker 實例，不可自己直接 new Worker，這樣才能確保：
 *   1. 所有 Worker 路徑計算邏輯統一（GitHub Pages 子路徑相容）
 *   2. 懶載入、銷毀時機、跨域隔離防呆這些規則不會在各個 Converter
 *      裡各寫一份、逐漸走鐘（drift）
 *
 * 【兩種生命週期策略】
 * - 「即用即丟」（Ephemeral）：圖片、文件（PDF/Word）轉檔使用。
 *   任務結束（無論成功/失敗/取消）就立刻 terminate()，不保留實例。
 * - 「常駐 + 閒置銷毀」（Persistent，僅限 FFmpeg）：影音轉檔使用。
 *   Wasm 編譯成本高，若每次轉檔都重新 new Worker 會讓使用者連續轉檔時
 *   體感非常慢，因此轉檔結束後刻意「保留」Worker 實例，開始一個 3 分鐘
 *   倒數；若期間有新任務進來，倒數會被清除、直接複用同一個 Worker；
 *   若 3 分鐘內都沒有新任務，才真正 terminate() 並清空實例。
 *
 * 【與 EventBus 的關係】
 * 本模組不直接操作 DOM，狀態變化一律透過 EventBus_instance.emit() 對外
 * 廣播；同時也「反過來」訂閱 EventBus 上的 'converter:cancel' 事件——
 * 這是刻意的設計：只有 WorkerLifecycle 自己知道「目前這個 tool 對應的
 * Worker 是即用即丟還是常駐」，因此取消邏輯的分支判斷應該收斂在這裡，
 * 而不是讓 Orchestrator 或 ui-bridge.js 越俎代庖去猜測該用哪種銷毀方式。
 * =============================================================================
 */

import { EventBus_instance } from './event-bus.js';

// -------------------------------------------------------------------------
// 對外事件名稱
// -------------------------------------------------------------------------
export const WORKER_LIFECYCLE_EVENTS = {
  // 任一 Worker（不論即用即丟或 FFmpeg 常駐）被 terminate() 之後觸發，
  // detail: { tool, kind: 'ephemeral' | 'ffmpeg', reason }
  WORKER_TERMINATED: 'converter:worker-terminated',

  // FFmpeg 常駐 Worker 的狀態變化，detail: { status, secondsRemaining? }
  // status 可能是 'created'（首次建立）/ 'reused'（複用既有實例，跳過重新編譯）
  // / 'idle-countdown-start'（開始 3 分鐘倒數）/ 'idle-countdown-cancelled'
  // （有新任務進來，倒數取消）
  FFMPEG_STATUS: 'converter:ffmpeg-status',

  // 沿用 Orchestrator 既有的錯誤事件名稱，讓 ui-bridge.js 不需要額外
  // 監聽新的事件名稱就能收到 Worker 相關的錯誤（例如跨域隔離不可用）。
  ERROR: 'converter:error',
};

// FFmpeg 常駐 Worker 的閒置銷毀時間：3 分鐘（毫秒）
const FFMPEG_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

// -------------------------------------------------------------------------
// 模組內部狀態
// -------------------------------------------------------------------------

/**
 * activeWorkers：記錄「目前每個 tool 正在使用中的 Worker」，
 * 供使用者按下取消時查找該用哪種銷毀策略。
 * 結構：{ image: WorkerHandle|null, document: WorkerHandle|null, video: WorkerHandle|null }
 *
 * WorkerHandle 結構：
 *   { worker: Worker, kind: 'ephemeral' | 'ffmpeg' }
 */
const activeWorkers = {
  image: null,
  document: null,
  video: null,
  audio: null,
  'ai-document': null,
  'gh-actions-document': null,
};

/** FFmpeg 常駐 Worker 的實例本身（與 activeWorkers.video 是同一個物件參考，
 *  這裡額外保留一份獨立變數，是因為 FFmpeg Worker 的「常駐」概念跟
 *  「目前是否有任務正在使用」是兩件事：即使 video 任務結束、
 *  activeWorkers.video 被清空，ffmpegWorkerInstance 仍然要保留著，
 *  直到 3 分鐘閒置倒數結束才清空。 */
let ffmpegWorkerInstance = null;

/** 目前的閒置銷毀計時器 id，用來在有新任務進來時 clearTimeout。 */
let ffmpegIdleTimerId = null;

/**
 * 快取最新一次的 DeviceProfile。
 * 本模組刻意不 import device-profiler.js（避免模組間產生直接依賴，
 * 違反「僅透過事件溝通」的架構原則），而是訂閱 EventBus 上的
 * 'converter:device-ready' 事件，被動接收最新的裝置剖繪結果。
 */
let latestDeviceProfile = null;
EventBus_instance.on('converter:device-ready', (profile) => {
  latestDeviceProfile = profile;
});

// =========================================================================
// 區塊 A：Worker 路徑解析
// =========================================================================

/**
 * resolveWorkerPath(workerFileName)
 * -------------------------------------------------------------------------
 * ⚠️ 重要：這裡刻意使用「純相對路徑」，不加 window.location.origin！
 *
 * 背景：在啟用 COOP/COEP 的跨域隔離環境下（本專案透過 coi-serviceworker.js
 * 模擬這兩個標頭），部分瀏覽器對 `new Worker(url)` 傳入「帶有完整協定的
 * 絕對網址」（例如 https://xxx.github.io/repo/workers/x.js）會直接拋出
 * SecurityError，即使該網址其實同源。純相對路徑（./workers/x.js）則能
 * 完全規避這個限制，且在 GitHub Pages 的任何子路徑部署下都能正確解析
 * （相對於目前執行的 index.html 或 converter-core.js 所在位置）。
 * -------------------------------------------------------------------------
 */
function resolveWorkerPath(workerFileName) {
  return `./workers/${workerFileName}`;
}

// =========================================================================
// 區塊 B：跨域隔離防禦
// =========================================================================

/**
 * ensureCrossOriginIsolated(tool, workerFileName)
 * -------------------------------------------------------------------------
 * 在建立「需要 SharedArrayBuffer」的 Worker（目前僅 FFmpeg）之前，
 * 必須先確認當前頁面確實處於跨域隔離狀態，否則 FFmpeg.wasm 內部
 * 嘗試配置 SharedArrayBuffer 時會直接拋出未捕捉的例外，導致整個分頁
 * 陷入白屏或主控台一片紅字，使用者完全不知道發生什麼事。
 *
 * 這裡採用「雙重確認」：
 *   1. window.crossOriginIsolated —— 瀏覽器當下最即時、最權威的真實旗標，
 *      這是最終會不會拋出 SharedArrayBuffer 例外的直接依據。
 *   2. latestDeviceProfile.isolation.status —— DeviceProfiler 先前算出的
 *      狀態（'isolated' / 'reloading' / 'unavailable'），主要用來組出
 *      更精確的錯誤文案（例如區分「還在重整過渡期」跟「環境確定不支援」）。
 *
 * 若判定不可用，會透過 EventBus 廣播 'converter:error'，並回傳 false
 * 讓呼叫方（getOrCreateFFmpegWorker）安全中止，不繼續執行 new Worker()。
 * -------------------------------------------------------------------------
 */
function ensureCrossOriginIsolated(tool) {
  const isIsolated = window.crossOriginIsolated === true;
  if (isIsolated) return true;

  // 依照 DeviceProfiler 回報的細節狀態，組出更精確的錯誤說明文字，
  // 若尚未收到過 device-ready 事件（理論上不該發生，因為 Orchestrator
  // 一定會先跑 DeviceProfiler），就退回一個通用文案。
  const isolationStatus = latestDeviceProfile?.isolation?.status;
  let message;
  if (isolationStatus === 'reloading') {
    message = '安全沙盒環境仍在初始化中，請稍候片刻再試一次影音轉檔。';
  } else {
    message =
      '此瀏覽器環境無法啟用安全沙盒（跨域隔離），影音轉檔功能需要的底層能力不可用，請確認 Service Worker 是否正常運作，或改用其他瀏覽器。';
  }

  console.error('[WorkerLifecycle] 跨域隔離不可用，已攔截 Worker 建立請求：', {
    tool,
    isolationStatus,
    crossOriginIsolated: window.crossOriginIsolated,
  });

  EventBus_instance.emit(WORKER_LIFECYCLE_EVENTS.ERROR, { tool, message });
  return false;
}

// =========================================================================
// 區塊 C：即用即丟 Worker（圖片 / 文件）
// =========================================================================

/**
 * createEphemeralWorker(tool, workerFileName)
 * -------------------------------------------------------------------------
 * 建立一個「用完就丟」的 Worker，適用於圖片與文件轉檔。
 *
 * 懶載入原則：這個函式本身就是懶載入的體現——它只會在 Converter
 * 真正要開始處理某個檔案時才被呼叫（由 ConverterOrchestrator 在收到
 * 'converter:start' 事件後才觸發整條轉檔流程），頁面剛載入、
 * DeviceProfiler 跑完的當下，這裡完全不會被執行到，不會有任何
 * Worker 被提早建立、佔用記憶體。
 * -------------------------------------------------------------------------
 */
export function createEphemeralWorker(tool, workerFileName) {
  const worker = new Worker(resolveWorkerPath(workerFileName), { type: 'module' });

  const handle = { worker, kind: 'ephemeral' };
  activeWorkers[tool] = handle;

  return worker;
}

/**
 * destroyEphemeralWorker(tool, reason)
 * -------------------------------------------------------------------------
 * 銷毀即用即丟 Worker 的唯一合法入口。
 * 呼叫時機（由 ConverterOrchestrator 負責觸發）：
 *   - 轉檔成功、使用者觸發下載後
 *   - 轉檔過程中發生錯誤
 *   - 使用者按下取消（實際上是透過下方的 EventBus 監聽器自動觸發，
 *     不需要 Orchestrator 額外呼叫）
 *
 * 銷毀後務必把 activeWorkers[tool] 設回 null，這是「清理變數參考、
 * 絕不殘留記憶體」規則的關鍵一步——若只呼叫 terminate() 卻沒有清空
 * 參考，這個物件仍然會被 activeWorkers 這個模組層級的物件持續引用著，
 * V8 的垃圾回收器就無法真正回收該 Worker 相關的記憶體。
 * -------------------------------------------------------------------------
 */
export function destroyEphemeralWorker(tool, reason = 'completed') {
  const handle = activeWorkers[tool];
  if (!handle || handle.kind !== 'ephemeral') return;

  handle.worker.terminate();
  activeWorkers[tool] = null; // 清空參考，允許 GC 回收

  EventBus_instance.emit(WORKER_LIFECYCLE_EVENTS.WORKER_TERMINATED, {
    tool,
    kind: 'ephemeral',
    reason,
  });
}

// =========================================================================
// 區塊 D：FFmpeg 常駐 Worker（影音）
// =========================================================================
// ⚠️ 【現狀說明】VideoConverter.js 實測後改成在主執行緒直接執行
// @ffmpeg/ffmpeg（詳見該檔案頂端的架構例外說明），不再呼叫這裡的
// getOrCreateFFmpegWorker() / releaseFFmpegWorkerAfterTask() /
// terminateFFmpegWorker()。這幾個函式目前保留、未被移除，是考慮到
// 未來若函式庫版本更新、修正了讓我們踩雷的問題，重新改回「真正的
// 常駐 Worker」方案時，這裡的邏輯與介面設計可以直接復用，不需要
// 重新設計一次。cancelActiveWorker() 內對應 'ffmpeg' 分支的邏輯
// 同理保留，只是目前不會有任何 tool 使用到 'ffmpeg' 這個 kind。
// =========================================================================

/**
 * clearFfmpegIdleTimer()
 * -------------------------------------------------------------------------
 * 內部小工具：清除目前排程中的閒置銷毀計時器（若有的話）。
 * 每當有新的影音任務進來、或是 Worker 已經被真正銷毀時，都需要呼叫這個
 * 函式，避免出現「計時器仍在背景倒數，時間到了卻去 terminate 一個
 * 已經被別的流程處理過的 Worker」這種競態問題。
 * -------------------------------------------------------------------------
 */
function clearFfmpegIdleTimer() {
  if (ffmpegIdleTimerId !== null) {
    clearTimeout(ffmpegIdleTimerId);
    ffmpegIdleTimerId = null;
  }
}

/**
 * getOrCreateFFmpegWorker()
 * -------------------------------------------------------------------------
 * 取得可用的 FFmpeg Worker 實例：
 *   - 若已存在常駐實例 → 清除閒置倒數計時器（因為又有新任務要用它了），
 *     直接複用，避免重新編譯 Wasm 的高昂成本，並廣播 status: 'reused'。
 *   - 若不存在 → 先做跨域隔離防呆檢查，通過才真正 new Worker()，
 *     並廣播 status: 'created'。
 *
 * 回傳值：成功時回傳 Worker 實例；跨域隔離檢查失敗時回傳 null
 * （呼叫方 VideoConverter 應該檢查回傳值是否為 null，若是則中止
 * 後續流程，不要嘗試對 null 呼叫 postMessage）。
 * -------------------------------------------------------------------------
 */
export function getOrCreateFFmpegWorker() {
  if (ffmpegWorkerInstance) {
    clearFfmpegIdleTimer();
    EventBus_instance.emit(WORKER_LIFECYCLE_EVENTS.FFMPEG_STATUS, { status: 'reused' });

    // 同步更新 activeWorkers.video，讓取消邏輯查得到目前正在使用中的實例。
    activeWorkers.video = { worker: ffmpegWorkerInstance, kind: 'ffmpeg' };
    return ffmpegWorkerInstance;
  }

  // 首次建立前，先確認跨域隔離可用，避免 FFmpeg.wasm 內部拋出
  // SharedArrayBuffer 相關的未捕捉例外，導致白屏。
  if (!ensureCrossOriginIsolated('video')) {
    return null;
  }

  ffmpegWorkerInstance = new Worker(resolveWorkerPath('ffmpeg-worker.js'), { type: 'module' });
  activeWorkers.video = { worker: ffmpegWorkerInstance, kind: 'ffmpeg' };

  EventBus_instance.emit(WORKER_LIFECYCLE_EVENTS.FFMPEG_STATUS, { status: 'created' });

  return ffmpegWorkerInstance;
}

/**
 * releaseFFmpegWorkerAfterTask()
 * -------------------------------------------------------------------------
 * 一次影音轉檔任務「成功完成」後呼叫（由 VideoConverter 在拿到轉檔結果、
 * 觸發下載之後呼叫，而不是在錯誤或取消時呼叫——那兩種情境有各自的
 * 處理函式，見下方 cancelActiveWorker 與 terminateFFmpegWorker）。
 *
 * 這裡「不」立即 terminate()，而是：
 *   1. 把 activeWorkers.video 清空（代表目前沒有任務正在使用它）
 *   2. 啟動 3 分鐘閒置倒數計時器
 *   3. 廣播 'idle-countdown-start'，讓 ui-bridge.js 未來若想顯示
 *      「引擎待命中」之類的小提示，有事件可以掛
 * -------------------------------------------------------------------------
 */
export function releaseFFmpegWorkerAfterTask() {
  if (!ffmpegWorkerInstance) return;

  activeWorkers.video = null;

  clearFfmpegIdleTimer();
  ffmpegIdleTimerId = setTimeout(() => {
    terminateFFmpegWorker('idle-timeout');
  }, FFMPEG_IDLE_TIMEOUT_MS);

  EventBus_instance.emit(WORKER_LIFECYCLE_EVENTS.FFMPEG_STATUS, {
    status: 'idle-countdown-start',
    secondsRemaining: FFMPEG_IDLE_TIMEOUT_MS / 1000,
  });
}

/**
 * terminateFFmpegWorker(reason)
 * -------------------------------------------------------------------------
 * 真正銷毀 FFmpeg 常駐 Worker 的唯一入口，會在以下情境被觸發：
 *   - 3 分鐘閒置倒數結束（reason: 'idle-timeout'）
 *   - 使用者取消轉檔時，若判斷已經沒有挽回必要（目前策略是取消一律走
 *     postMessage 優雅中斷，見 cancelActiveWorker，這裡先保留 reason
 *     擴充彈性，未來若要支援「使用者離開頁面」等情境可以直接呼叫本函式）
 *
 * 銷毀後同樣要清空所有相關參考（ffmpegWorkerInstance、
 * activeWorkers.video、閒置計時器 id），確保沒有殘留參考擋住 GC。
 * -------------------------------------------------------------------------
 */
export function terminateFFmpegWorker(reason = 'manual') {
  if (!ffmpegWorkerInstance) return;

  clearFfmpegIdleTimer();
  ffmpegWorkerInstance.terminate();
  ffmpegWorkerInstance = null;
  activeWorkers.video = null;

  EventBus_instance.emit(WORKER_LIFECYCLE_EVENTS.WORKER_TERMINATED, {
    tool: 'video',
    kind: 'ffmpeg',
    reason,
  });
  EventBus_instance.emit(WORKER_LIFECYCLE_EVENTS.FFMPEG_STATUS, { status: 'terminated', reason });
}

/**
 * registerMainThreadTask(tool, { onCancel })
 * -------------------------------------------------------------------------
 * 【新增】部分轉檔邏輯（例如 PdfConverter 的 PDF 轉圖片方向）基於外部
 * 函式庫本身的架構限制（pdf.js 的公開 API 設計上假設呼叫端本身就是
 * 主執行緒，無法安全地在我們自己的 Worker 裡面再呼叫一次），必須直接
 * 在主執行緒執行，不透過真正的 Worker 物件。
 *
 * 但 hasActiveWorker(tool) 的「防止重複提交」檢查，以及使用者按下
 * 取消時的分派邏輯，都是靠 activeWorkers 這個內部登記表運作的。
 * 為了讓這類「沒有真正 Worker 實例」的任務也能參與同一套防禦機制，
 * 這裡提供一組平行的登記函式：用 kind: 'main-thread' 標記，
 * 並用呼叫方提供的 onCancel 回呼取代原本的 worker.postMessage()/
 * worker.terminate()。
 * -------------------------------------------------------------------------
 */
export function registerMainThreadTask(tool, { onCancel } = {}) {
  activeWorkers[tool] = { kind: 'main-thread', onCancel: onCancel || null };
}

/**
 * clearMainThreadTask(tool, reason)
 * -------------------------------------------------------------------------
 * 主執行緒任務結束（成功/失敗/取消完成）後呼叫，清空登記表項目，
 * 讓 hasActiveWorker(tool) 恢復回報 false，並廣播跟 Worker 版本一致的
 * WORKER_TERMINATED 事件（kind 標記為 'main-thread'，方便未來如果有
 * 監聽端想要區分兩種任務型態的統計用途）。
 * -------------------------------------------------------------------------
 */
export function clearMainThreadTask(tool, reason = 'completed') {
  const handle = activeWorkers[tool];
  if (!handle || handle.kind !== 'main-thread') return;

  activeWorkers[tool] = null;
  EventBus_instance.emit(WORKER_LIFECYCLE_EVENTS.WORKER_TERMINATED, {
    tool,
    kind: 'main-thread',
    reason,
  });
}

// =========================================================================
// 區塊 E：統一取消入口（訂閱 EventBus 的 'converter:cancel'）
// =========================================================================

/**
 * cancelActiveWorker(tool)
 * -------------------------------------------------------------------------
 * 使用者按下取消時的核心分派邏輯，依照 activeWorkers[tool] 記錄的
 * kind 決定要「暴力終結」還是「優雅中斷」：
 *
 *   - kind === 'ephemeral'（圖片/文件）→ 直接 terminate()。
 *     這類 Worker 本來就是用完即丟，沒有「保留給下次用」的價值，
 *     暴力終結不會有任何副作用。
 *
 *   - kind === 'ffmpeg'（影音）→ 絕對不能直接 terminate()！
 *     必須改用 postMessage 送出取消訊號，讓 FFmpeg.wasm 內部有機會
 *     自行中止當前運算並清理內部狀態，執行緒本身則繼續存活、
 *     維持「常駐」的設計目的（避免下次任務又要重新編譯 Wasm）。
 *     訊號格式 { type: 'cancel' } 由 ffmpeg-worker.js 端負責監聽解讀，
 *     實際的中斷實作屬於 VideoConverter / ffmpeg-worker.js 的職責，
 *     本模組只負責「送出訊號」這個動作本身。
 * -------------------------------------------------------------------------
 */
function cancelActiveWorker(tool) {
  const handle = activeWorkers[tool];
  if (!handle) return; // 該分頁目前沒有任何 Worker 在跑，無需處理

  if (handle.kind === 'ephemeral') {
    destroyEphemeralWorker(tool, 'user-cancelled');
    return;
  }

  if (handle.kind === 'ffmpeg') {
    handle.worker.postMessage({ type: 'cancel' });

    // -----------------------------------------------------------------
    // 【Race Condition 防禦】刻意「不」清空 activeWorkers.video！
    //
    // 送出取消訊號後，FFmpeg.wasm 內部的中斷屬於非同步過程（它需要時間
    // 走完自己的清理流程，才能安全地被下一個任務複用）。如果這裡提早
    // 把 activeWorkers.video 設回 null，會讓 hasActiveWorker('video')
    // 錯誤地回報「目前沒有任務在跑」——若使用者在這個空窗期立刻選了
    // 新檔案並點擊開始轉檔，getOrCreateFFmpegWorker() 會直接複用同一個
    // 「其實還在忙著處理舊任務中斷」的 Worker 實例，導致舊任務的中斷
    // 訊息與新任務的處理訊息在同一個 Worker 內互相干擾，產生難以重現、
    // 高度隨機性的詭異 Bug。
    //
    // 正確流程：activeWorkers.video 必須維持「佔用中」狀態，
    // 直到 ffmpeg-worker.js 端確實完成內部清理、postMessage 回報
    // { type: 'cancelled' } 之後，由呼叫端（VideoConverter）在收到
    // 這個回報訊息時，才顯式呼叫 releaseFFmpegWorkerAfterTask()
    // 走正常的「3 分鐘閒置倒數」流程，此時 activeWorkers.video 才會
    // 被清空、Worker 才真正被視為「可安全複用」。
    // -----------------------------------------------------------------
    EventBus_instance.emit(WORKER_LIFECYCLE_EVENTS.FFMPEG_STATUS, {
      status: 'cancel-signal-sent',
    });
  }
}

// 訂閱 'converter:cancel'：ui-bridge.js 送出這個事件時（見
// initCancelButton），本模組會自動依照上面的分派邏輯處理，
// Orchestrator 完全不需要為了「取消」這件事額外寫任何轉發程式碼。
EventBus_instance.on('converter:cancel', ({ tool }) => {
  cancelActiveWorker(tool);
});

// =========================================================================
// 區塊 F：對外查詢工具（供 Orchestrator / Converter 使用）
// =========================================================================

/**
 * hasActiveWorker(tool)
 * -------------------------------------------------------------------------
 * 提供給 ConverterOrchestrator 在收到新的 'converter:start' 時，
 * 先檢查該分頁是否已經有任務在跑（避免使用者連續快速點擊「開始轉檔」
 * 導致同一個 tool 底下同時存在兩個 Worker 搶佔記憶體）。
 * -------------------------------------------------------------------------
 */
export function hasActiveWorker(tool) {
  return activeWorkers[tool] !== null;
}
