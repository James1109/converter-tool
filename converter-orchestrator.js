/**
 * =============================================================================
 * converter-orchestrator.js
 * =============================================================================
 * 【模組定位】
 * 核心調度器（Orchestrator），是「UI → core」事件的第一個、也是唯一的
 * 業務分流入口。ui-bridge.js 送出的 'converter:start' 最終都會先經過
 * 這裡，再依照 tool 類型（'image' / 'document' / 'video'）分派給
 * 對應的 Converter 模組處理。
 *
 * 【職責邊界】
 * - 負責「要不要開始」的前置判斷（目前是否已有任務在跑），
 *   以及「該交給誰處理」的路由判斷。
 * - 不負責實際的轉檔邏輯（那是各 Converter 的工作）、
 *   不負責 Worker 生死管理（那是 WorkerLifecycle 的工作）、
 *   不負責畫面呈現（那是 ui-bridge.js 的工作）。
 * - 本模組是目前架構中「認識最多其他模組」的角色（需要 import
 *   WorkerLifecycle 與各個 Converter），這是刻意的設計：業務路由邏輯
 *   本來就需要知道有哪些選項可以路由，把這個「知道全貌」的責任集中在
 *   一個地方，可以避免其他模組（例如 VideoConverter）互相認識彼此，
 *   維持各 Converter 之間完全解耦。
 * =============================================================================
 */

import { EventBus_instance } from './event-bus.js';
import { hasActiveWorker } from './worker-lifecycle.js';
import { checkVideoFileAgainstLimit, evaluateMemoryRisk } from './device-profiler.js';
import * as VideoConverter from './converters/VideoConverter.js';
import * as AudioConverter from './converters/AudioConverter.js';
import * as ImageConverter from './converters/ImageConverter.js';
import * as PdfConverter from './converters/PdfConverter.js';
import * as AiDocumentConverter from './converters/AiDocumentConverter.js';
import * as GithubActionsConverter from './converters/GithubActionsConverter.js';

// -------------------------------------------------------------------------
// 快取最新一次的 DeviceProfile。
// 跟 worker-lifecycle.js 採用同樣的做法：訂閱 EventBus 上的
// 'converter:device-ready' 被動接收，不直接 import device-profiler.js，
// 避免模組之間產生「誰先載入誰」的隱性順序依賴。
// -------------------------------------------------------------------------
let latestDeviceProfile = null;
EventBus_instance.on('converter:device-ready', (profile) => {
  latestDeviceProfile = profile;
});

/**
 * TOOL_LABELS
 * -------------------------------------------------------------------------
 * 純粹給錯誤訊息使用的中文對照表，避免在 handleStart() 裡用一堆
 * if-else 組字串，也方便未來要調整文案時只需要改這裡一處。
 * -------------------------------------------------------------------------
 */
const TOOL_LABELS = {
  image: '圖片',
  document: '文件',
  video: '影音',
  audio: '音訊',
  'ai-document': 'AI 文件處理',
  'gh-actions-document': '進階轉檔（GitHub Actions）',
};

/**
 * handleFileSelected({ tool, file })
 * -------------------------------------------------------------------------
 * 'converter:file-selected' 事件的處理函式。使用者一選定檔案，
 * ui-bridge.js 就會立刻送出這個事件（見 ui-bridge.js 的
 * handleFileChosen()），這裡的職責是：依照 DeviceProfiler 算好的規則，
 * 判斷這個檔案能不能轉、要不要先跳警告，並把結果透過
 * 'converter:file-check-result' 回報給 UI（ui-bridge.js 的
 * handleFileCheckResult() 會依 action 決定要鎖按鈕、跳 Modal，
 * 還是顯示柔性警告文字）。
 *
 * 為什麼這裡「直接 import」device-profiler.js 的兩個純函式，
 * 而不是像 latestDeviceProfile 那樣透過 EventBus 被動接收：
 * checkVideoFileAgainstLimit() 與 evaluateMemoryRisk() 都是「無副作用
 * 的純函式」（輸入固定、輸出固定，不依賴任何模組內部狀態，
 * evaluateMemoryRisk 雖然會 emit 事件，但那個事件本身就是它對外
 * 溝通的合法管道）。ConverterOrchestrator 本來就是架構上「被允許
 * 認識最多其他模組」的角色，直接 import 純函式類型的工具，
 * 比起訂閱事件再等回覆更直接，也不會產生前面提到的「隱性狀態耦合」
 * 問題——真正需要避免直接 import 的是「帶有內部狀態、需要被
 * 初始化」的模組（例如 device-profiler.js 的 initDeviceProfiler()
 * 本身），這點跟這裡匯入的兩個純函式是不同情況。
 * -------------------------------------------------------------------------
 */
// 快取「上一次選檔時評估出來的記憶體風險結果」，key 是 tool，
// value 是 evaluateMemoryRisk() 的回傳物件（isRisky 為 false 時存
// null）。選檔當下用這個結果觸發非阻擋橫幅提示；使用者真正按下
// 「開始轉檔」時，改用這份快取結果觸發「真正需要確認」的阻擋型
// Modal，兩個時機點各司其職、不會互相干擾或要求使用者確認兩次。
const lastRiskByTool = {};

function handleFileSelected({ tool, file }) {
  // 防禦：理論上 DeviceProfiler 一定會在使用者能夠選擇檔案之前就先
  // 執行完成（頁面初始化流程），但仍保留這層檢查，避免任何極端時序
  // 下（例如未來改成非同步載入 DeviceProfiler）對 null 物件解構出錯。
  if (!latestDeviceProfile) {
    console.warn('[ConverterOrchestrator] 尚未收到 DeviceProfile，暫時放行不做限制檢查。');
    lastRiskByTool[tool] = null;
    EventBus_instance.emit('converter:file-check-result', {
      tool,
      action: 'proceed',
      message: null,
    });
    return;
  }

  // ---- 影音：套用 Safari 硬性限制 / Chromium 柔性提醒 / 行動端阻擋 ----
  if (tool === 'video') {
    const result = checkVideoFileAgainstLimit(file.size, latestDeviceProfile.videoLimit);
    EventBus_instance.emit('converter:file-check-result', {
      tool,
      action: result.action,
      message: result.message,
    });
    // 記憶體風險評估恢復在選檔當下就做（觸發非阻擋橫幅提示），
    // 並把結果快取起來，供 handleStart() 在使用者真正按下「開始
    // 轉檔」時，拿去觸發真正需要確認的阻擋型 Modal。
    if (result.action !== 'block') {
      const risk = evaluateMemoryRisk(file.size, latestDeviceProfile);
      lastRiskByTool[tool] = risk.isRisky ? risk : null;
    } else {
      lastRiskByTool[tool] = null;
    }
    return;
  }

  // ---- 文件：套用行動端 5MB 限制（documentLimit 是 DeviceProfiler
  //       在頁面載入時就算好的靜態規則，這裡只需要拿檔案大小比對） ----
  if (tool === 'document') {
    const limit = latestDeviceProfile.documentLimit;
    const isOverLimit =
      limit.mode === 'hard-limit' && file.size > limit.maxSizeMB * 1024 * 1024;

    EventBus_instance.emit('converter:file-check-result', {
      tool,
      action: isOverLimit ? 'block' : 'proceed',
      message: isOverLimit ? limit.message : null,
    });

    if (!isOverLimit) {
      const risk = evaluateMemoryRisk(file.size, latestDeviceProfile);
      lastRiskByTool[tool] = risk.isRisky ? risk : null;
    } else {
      lastRiskByTool[tool] = null;
    }
    return;
  }

  // ---- 圖片：目前規格書沒有訂出固定大小限制，僅需評估記憶體風險 ----
  if (tool === 'image') {
    EventBus_instance.emit('converter:file-check-result', {
      tool,
      action: 'proceed',
      message: null,
    });
    const risk = evaluateMemoryRisk(file.size, latestDeviceProfile);
    lastRiskByTool[tool] = risk.isRisky ? risk : null;
    return;
  }

  // ---- 音訊：跟影音共用同一顆 FFmpeg 引擎，行動端限制沿用
  //       videoLimit 的封鎖規則（規格書沒有另外訂定音訊專屬限制，
  //       但音訊轉檔同樣依賴 FFmpeg.wasm，行動端資源有限的疑慮跟
  //       影音是一樣的道理，沿用同一套規則較為保守安全） ----
  if (tool === 'audio') {
    if (latestDeviceProfile.isMobileOrTablet) {
      EventBus_instance.emit('converter:file-check-result', {
        tool,
        action: 'block',
        message: '手機與平板裝置不支援音訊轉檔功能，請改用桌面版瀏覽器。',
      });
      lastRiskByTool[tool] = null;
      return;
    }

    EventBus_instance.emit('converter:file-check-result', {
      tool,
      action: 'proceed',
      message: null,
    });
    const risk = evaluateMemoryRisk(file.size, latestDeviceProfile);
    lastRiskByTool[tool] = risk.isRisky ? risk : null;
    return;
  }

  // ---- AI 文件處理：依規格書，此功能在行動端「不」被封鎖（與影音/
  //       音訊不同），因為實際運算是丟給遠端 AI API 處理，本機只負責
  //       mammoth.js 解析（Word 檔通常不大）與最終的 html2pdf 渲染，
  //       資源壓力遠低於 FFmpeg.wasm，因此僅做一般記憶體風險評估，
  //       不套用行動端封鎖或固定檔案大小上限。 ----
  if (tool === 'ai-document') {
    EventBus_instance.emit('converter:file-check-result', {
      tool,
      action: 'proceed',
      message: null,
    });
    const risk = evaluateMemoryRisk(file.size, latestDeviceProfile);
    lastRiskByTool[tool] = risk.isRisky ? risk : null;
    return;
  }

  // ---- 進階轉檔（GitHub Actions + LibreOffice）：實際運算完全發生在
  //       使用者自己的 GitHub Actions 虛擬機器上，本機只負責上傳/輪詢/
  //       下載，資源壓力極低，一律放行，不做檔案大小或行動端封鎖。 ----
  if (tool === 'gh-actions-document') {
    EventBus_instance.emit('converter:file-check-result', {
      tool,
      action: 'proceed',
      message: null,
    });
    return;
  }

  console.warn('[ConverterOrchestrator] 收到未知的 tool 類型，無法驗證檔案：', tool);
}

/**
 * waitForMemoryRiskConfirmation()
 * -------------------------------------------------------------------------
 * 把 EventBus 的一次性事件監聽（.once()）包成 Promise，讓 handleStart()
 * 可以用 await 的方式「暫停」在這裡，直到使用者在 ui-bridge.js 跳出的
 * 'memory-warning' Modal 上按下「取消」或「仍要繼續」為止。
 *
 * 用 EventBus_instance.once() 而不是 .on()：確保這個監聽器只會被觸發
 * 一次就自動取消訂閱，不會在下一次任務又收到記憶體風險事件時，殘留
 * 一個「還在等上一次回覆」的過期監聽器繼續佔著。
 * -------------------------------------------------------------------------
 */
function waitForMemoryRiskConfirmation() {
  return new Promise((resolve) => {
    EventBus_instance.once('converter:memory-risk-response', ({ confirmed }) => {
      resolve(confirmed === true);
    });
  });
}

/**
 * handleStart({ tool, file, options })
 * -------------------------------------------------------------------------
 * 'converter:start' 事件的唯一處理函式，現在是 async 函式。完整流程：
 *
 *   1. 重複提交防禦：透過 WorkerLifecycle.hasActiveWorker(tool) 確認
 *      該分頁目前沒有任務正在進行（含 PdfConverter/VideoConverter 各自
 *      的主執行緒 isBusy() 補充檢查）。
 *
 *   2.【產品決策更新：記憶體風險真正攔截轉檔流程】
 *      在這裡（而不是選檔當下）才呼叫 evaluateMemoryRisk()，理由：
 *      選檔時評估屬於「太早」的資訊性提示，容易讓使用者在還沒決定
 *      要不要轉檔前就被打斷；改成在使用者明確按下「開始轉檔」、
 *      真正要花運算資源的這一刻才評估，並且「暫停」等待使用者在
 *      Modal 上的選擇——若使用者選擇「取消」，直接中止這次任務，
 *      不會呼叫任何 Converter。
 *
 *   3. 依 tool 類型路由：
 *      - 'video' → 交給 VideoConverter.start()
 *      - 'image' → 交給 ImageConverter.start()（真實可用的 Canvas 實作）
 *      - 'document' → 交給 PdfConverter.start()
 * -------------------------------------------------------------------------
 */
async function handleStart({ tool, file, options }) {
  const isBusy =
    hasActiveWorker(tool) ||
    (tool === 'document' && PdfConverter.isBusy()) ||
    (tool === 'video' && VideoConverter.isBusy()) ||
    (tool === 'audio' && AudioConverter.isBusy()) ||
    (tool === 'ai-document' && AiDocumentConverter.isBusy()) ||
    (tool === 'gh-actions-document' && GithubActionsConverter.isBusy());

  if (isBusy) {
    EventBus_instance.emit('converter:error', {
      tool,
      message: `目前已有一個${TOOL_LABELS[tool] || tool}轉檔任務正在執行中，請等待完成或先取消後再試一次。`,
    });
    return;
  }

  const risk = lastRiskByTool[tool];
  if (risk && risk.isRisky) {
    // ⭐ 關鍵修正 ⭐ 不再呼叫 evaluateMemoryRisk() 重新評估一次
    // （那樣做會重新 emit 'converter:memory-risk'，而 ui-bridge.js
    // 對這個事件的處理是非阻擋橫幅、沒有任何按鈕，會導致下面的
    // waitForMemoryRiskConfirmation() 永遠等不到回覆而卡死）。
    // 改成直接用選檔當下快取的風險結果，emit 一個獨立的
    // 'converter:memory-risk-confirm-request' 事件，讓 ui-bridge.js
    // 對這個事件的專屬處理跳出「真正需要確認」的阻擋型 Modal。
    EventBus_instance.emit('converter:memory-risk-confirm-request', risk);

    const confirmed = await waitForMemoryRiskConfirmation();
    if (!confirmed) {
      EventBus_instance.emit('converter:error', {
        tool,
        message: '已取消轉檔（記憶體風險提示未確認繼續）。',
      });
      return;
    }
  }

  if (tool === 'video') {
    VideoConverter.start(file, options);
    return;
  }

  if (tool === 'audio') {
    AudioConverter.start(file, options);
    return;
  }

  if (tool === 'image') {
    ImageConverter.start(file, options);
    return;
  }

  if (tool === 'document') {
    // PdfConverter.start() 是 async 函式（內部需要先 await
    // FontCacheManager.ensureFontReady()），這裡刻意不 await，
    // 因為後續所有結果都會透過 EventBus 事件驅動送回來。
    PdfConverter.start(file, options);
    return;
  }

  if (tool === 'ai-document') {
    // 同 PdfConverter：內部有 await（fetch AI API），刻意不 await，
    // 結果一律透過 EventBus 事件回報。
    AiDocumentConverter.start(file, options);
    return;
  }

  if (tool === 'gh-actions-document') {
    GithubActionsConverter.start(file, options);
    return;
  }

  console.warn('[ConverterOrchestrator] 收到未知的 tool 類型，無法路由：', tool);
}

/**
 * initConverterOrchestrator()
 * -------------------------------------------------------------------------
 * 對外進入點，由 converter-core.js 在啟動流程中呼叫一次。
 * 加上簡單的重入防護（isInitialized），避免未來如果 converter-core.js
 * 不慎被呼叫兩次初始化，導致同一個 'converter:start' 事件被處理兩次
 * （EventBus 的 Set 機制雖然能防止「同一個函式參考」被重複註冊，
 * 但如果每次呼叫 initConverterOrchestrator() 都是傳入一個新的箭頭函式
 * 參考，Set 就無法辨識出是重複訂閱，因此還是額外加一層防護較保險）。
 * -------------------------------------------------------------------------
 */
let isInitialized = false;

export function initConverterOrchestrator() {
  if (isInitialized) {
    console.warn('[ConverterOrchestrator] 已經初始化過，忽略重複呼叫。');
    return;
  }
  isInitialized = true;

  EventBus_instance.on('converter:file-selected', handleFileSelected);
  EventBus_instance.on('converter:start', handleStart);

  console.info('[ConverterOrchestrator] 初始化完成，已開始監聽 converter:file-selected 與 converter:start。');
}
