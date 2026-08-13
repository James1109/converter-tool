/**
 * =============================================================================
 * progress-guard.js
 * =============================================================================
 * 【模組定位】
 * 坐在「各 Converter 的原始進度回報」與「UI 實際看到的進度」之間，
 * 是唯一負責進度防退與 90% 後偽裝節流的地方。
 *
 * 【資料流向的關鍵改動】
 * 為了讓這一層能夠介入，各 Converter（VideoConverter / ImageConverter /
 * PdfConverter）不再直接 emit 'converter:progress'，而是改 emit
 * 'converter:progress-raw'（原始、未經處理的數值，可能不遞增、
 * 可能在 90% 附近卡住很久）。ProgressGuard 訂閱這個「raw」事件，
 * 處理過後才 emit 真正的 'converter:progress'，ui-bridge.js 完全
 * 不需要修改，繼續監聽 'converter:progress' 即可，這一層的存在
 * 對 UI 端是透明的。
 *
 * 【兩種防禦機制】
 * 1. 防退：新進度必須大於目前記錄的 safeProgress 才會被採用，
 *    否則直接忽略這次回報，UI 進度條「保持不動」。
 * 2. 90% 後偽裝節流：轉檔尾聲（寫入 Blob 等收尾階段）原始進度常常
 *    會長時間停滯不動，若什麼都不做，使用者會誤以為網頁當機。
 *    因此一旦 safeProgress 跨過 90%，就啟動一個每秒跳動 +0.2% 的
 *    計時器，持續往前爬但爬得很慢，直到「真正完成」的事件
 *    （'converter:result'）到來，才瞬間跳到 100%。
 * =============================================================================
 */

import { EventBus_instance } from './event-bus.js';

// 90% 後偽裝節流的每秒增量與時間間隔
const DISGUISE_INCREMENT_PERCENT = 0.2;
const DISGUISE_INTERVAL_MS = 1000;
// 偽裝節流的上限：故意停在 99.8% 而不是 99.9% 或 100%，
// 保留一段明顯的「最後一哩路」給真正完成時的瞬間跳轉，
// 讓「卡在 99.x% 很久 → 突然跳到 100%」這個視覺效果更明確，
// 使用者能清楚感受到「終於做完了」而不是又是一次普通的進度更新。
const DISGUISE_CAP_PERCENT = 99.8;
// 進入偽裝節流模式的門檻
const DISGUISE_THRESHOLD_PERCENT = 90;

/**
 * 每個 tool 各自獨立的進度狀態。
 * 結構：{ safeProgress: number, label: string, intervalId: number|null }
 *
 * 用 tool 當作 key（而非用 taskId），是因為 UI 端的進度條本來就是
 * 「每個分頁一條」，不需要細到用 taskId 區分——一個 tool 同一時間
 * 也只會有一個任務在跑（WorkerLifecycle 的前提），用 tool 當 key
 * 已經足夠且更簡單。
 */
const progressStates = new Map();

function getState(tool) {
  if (!progressStates.has(tool)) {
    progressStates.set(tool, { safeProgress: 0, label: '', intervalId: null });
  }
  return progressStates.get(tool);
}

/** 停止某個 tool 目前正在跑的偽裝節流計時器（若有的話）。 */
function stopDisguiseInterval(state) {
  if (state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
}

/** 把目前的 safeProgress 對外廣播成真正的 'converter:progress' 事件。 */
function emitProgress(tool, state, overrideLabel) {
  EventBus_instance.emit('converter:progress', {
    tool,
    percent: Math.round(state.safeProgress * 10) / 10,
    label: overrideLabel || state.label,
  });
}

/**
 * startDisguiseInterval(tool, state)
 * -------------------------------------------------------------------------
 * 啟動 90% 後的偽裝節流計時器。若已經在跑（例如同一個 tool 陸續收到
 * 好幾筆都 >90% 的原始進度），直接略過，不重複啟動多個計時器。
 * -------------------------------------------------------------------------
 */
function startDisguiseInterval(tool, state) {
  if (state.intervalId !== null) return;

  state.intervalId = setInterval(() => {
    if (state.safeProgress >= DISGUISE_CAP_PERCENT) {
      // 已經逼近上限，不需要再繼續跳動，但也不主動停止計時器——
      // 保留計時器運作中，是為了防禦「真正完成事件遲遲不來」的情境
      // 下，至少畫面上的數字停在一個穩定值，而不是計時器提早關閉後
      // 又有新的 raw progress 進來時邏輯要重新判斷是否要重啟。
      return;
    }
    state.safeProgress = Math.min(
      DISGUISE_CAP_PERCENT,
      Math.round((state.safeProgress + DISGUISE_INCREMENT_PERCENT) * 10) / 10
    );
    emitProgress(tool, state);
  }, DISGUISE_INTERVAL_MS);
}

/**
 * handleRawProgress({ tool, percent, label })
 * -------------------------------------------------------------------------
 * 'converter:progress-raw' 事件的處理函式，是防退演算法的核心。
 * -------------------------------------------------------------------------
 */
function handleRawProgress({ tool, percent, label }) {
  const state = getState(tool);
  if (label) {
    state.label = label;
  }

  // ---- 防退：新進度必須嚴格大於目前記錄值，否則整次忽略 ----
  if (percent <= state.safeProgress) {
    return;
  }

  if (percent < DISGUISE_THRESHOLD_PERCENT) {
    // 一般階段：原始進度還沒到 90%，代表轉檔核心確實在正常回報進度，
    // 直接跟隨即可，同時確保沒有殘留的偽裝節流計時器在背景空轉
    // （理論上不應該發生——一旦跨過 90% 就不會再收到 <90% 的合法
    // 遞增進度——但防禦性地清一次，避免任何未預期的時序问题）。
    stopDisguiseInterval(state);
    state.safeProgress = percent;
    emitProgress(tool, state);
    return;
  }

  // ---- percent >= 90：進入偽裝節流階段 ----
  // 先讓 safeProgress 至少反映這次收到的真實數值（可能是 90、95 等），
  // 再啟動計時器，之後就不再理會後續零星收到的 raw progress，
  // 全部交給計時器每秒 +0.2% 推進，直到真正完成事件到來。
  state.safeProgress = percent;
  emitProgress(tool, state);
  startDisguiseInterval(tool, state);
}

/**
 * handleTaskCompleted(tool)
 * -------------------------------------------------------------------------
 * 對應 'converter:result'：任務真正、成功地完成了。
 * 停止偽裝節流計時器，瞬間把 safeProgress 拉到 100%，廣播一次最終
 * 的進度事件（讓 UI 進度條視覺上補滿），然後重置這個 tool 的狀態，
 * 為下一次任務做準備（若不重置，下次任務的初始進度會因為
 * 「必須大於 100」而被防退機制整個吃掉）。
 * -------------------------------------------------------------------------
 */
function handleTaskCompleted(tool) {
  const state = getState(tool);
  stopDisguiseInterval(state);
  state.safeProgress = 100;
  emitProgress(tool, state, '轉換完成');

  // 重置，供下一次任務使用。
  state.safeProgress = 0;
  state.label = '';
}

/**
 * handleTaskAborted(tool)
 * -------------------------------------------------------------------------
 * 對應 'converter:error' 與 'converter:cancelled'：任務沒有成功完成，
 * 不需要（也不應該）把進度條拉到 100%，單純停止計時器並重置狀態即可
 * ——UI 端在收到 error/cancelled 時本來就會隱藏整個進度區塊，
 * 不會有人看到這個「歸零」的瞬間。
 * -------------------------------------------------------------------------
 */
function handleTaskAborted(tool) {
  const state = getState(tool);
  stopDisguiseInterval(state);
  state.safeProgress = 0;
  state.label = '';
}

// -------------------------------------------------------------------------
// 對外初始化入口
// -------------------------------------------------------------------------
let isInitialized = false;

export function initProgressGuard() {
  if (isInitialized) {
    console.warn('[ProgressGuard] 已經初始化過，忽略重複呼叫。');
    return;
  }
  isInitialized = true;

  EventBus_instance.on('converter:progress-raw', handleRawProgress);
  EventBus_instance.on('converter:result', ({ tool }) => handleTaskCompleted(tool));
  EventBus_instance.on('converter:error', ({ tool }) => handleTaskAborted(tool));
  EventBus_instance.on('converter:cancelled', ({ tool }) => handleTaskAborted(tool));

  console.info('[ProgressGuard] 初始化完成，已開始監聽 converter:progress-raw。');
}
