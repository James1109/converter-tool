/**
 * =============================================================================
 * EventBus.js
 * =============================================================================
 * 【模組定位】
 * 提供一個獨立於 DOM 的標準 Pub/Sub（發布/訂閱）事件匯流排。
 *
 * 為什麼現階段用 document.dispatchEvent，之後卻要換成這個 EventBus：
 * 1. document.dispatchEvent 依賴瀏覽器的 DOM 事件系統，理論上「核心邏輯」
 *    使用它會有點微妙地碰到 DOM API（雖然不是操作畫面節點，但技術上
 *    document 仍是一個 DOM 物件）。改用純 JS 物件實作的 EventBus，
 *    可以讓 core 端徹底不依賴任何 DOM/BOM 全域物件，未來如果要把
 *    core 邏輯搬到 Web Worker 內部（Worker 環境沒有 document），
 *    或甚至搬到 Node.js 環境跑單元測試，都不會因為呼叫
 *    document.dispatchEvent 而直接報錯。
 * 2. CustomEvent 的 detail 只能塞一份資料，且事件物件本身有不少
 *    瀏覽器規範帶來的額外屬性（bubbles、cancelable、composed...），
 *    對純邏輯溝通來說是不必要的重量；EventBus.emit(name, ...args)
 *    可以直接傳遞任意數量、任意型別的參數，介面更單純。
 * 3. 標準 Pub/Sub 的 on/off 介面，能讓呼叫方明確拿到「取消訂閱」的
 *    handle，避免 document.removeEventListener 需要額外保留 handler
 *    參考才能取消訂閱的麻煩。
 *
 * 【遷移計畫】
 * 這一版 EventBus 先獨立完成並提供完整測試好的 on/off/emit 介面。
 * 下一步會回頭把 device-profiler.js 內的
 *   document.dispatchEvent(new CustomEvent(name, { detail }))
 * 全部替換成
 *   EventBus.emit(name, detail)
 * 並且提供一個過渡期的相容層（見下方 bridgeToDom()），讓還沒改造完成的
 * ui-bridge.js（目前用 document.addEventListener 監聽）在遷移期間
 * 仍然收得到事件，等 ui-bridge.js 也改用 EventBus.on() 之後，
 * 再把這個相容層拿掉即可。
 * =============================================================================
 */

/**
 * -----------------------------------------------------------------------
 * class EventBus
 * -----------------------------------------------------------------------
 * 內部用一個 Map<eventName, Set<listenerFn>> 儲存訂閱關係：
 *   - 用 Map 是因為事件名稱數量不固定、且需要快速依名稱查找對應集合。
 *   - 用 Set（而非 Array）儲存同一事件底下的多個 listener，
 *     是因為 Set 天生就能防止「同一個函式參考被重複註冊兩次」，
 *     若呼叫方不慎對同一個 handler 呼叫兩次 on()，Set 會自動去重，
 *     避免同一個處理邏輯被觸發兩次造成的 bug（例如進度條被更新兩次）。
 * -----------------------------------------------------------------------
 */
class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * on(eventName, listener)
   * ---------------------------------------------------------------------
   * 訂閱一個事件。
   * @param {string} eventName - 事件名稱，例如 'converter:progress'
   * @param {(...args: any[]) => void} listener - 事件觸發時要執行的回呼函式
   * @returns {() => void} 回傳一個「取消訂閱」函式，呼叫它等同於 off()，
   *          這種寫法方便呼叫方直接把回傳值存起來，需要清理時直接呼叫，
   *          不需要額外保留 eventName 和 listener 的參考。
   *          例如：const unsubscribe = EventBus.on('x', fn); ... ; unsubscribe();
   */
  on(eventName, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError(`[EventBus] on('${eventName}', listener) 的 listener 必須是函式`);
    }

    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
    }
    this._listeners.get(eventName).add(listener);

    return () => this.off(eventName, listener);
  }

  /**
   * once(eventName, listener)
   * ---------------------------------------------------------------------
   * 訂閱一個「只觸發一次」的事件，觸發後自動取消訂閱。
   * 常見使用情境：等待某個一次性的初始化完成事件（例如
   * 'converter:isolation-status' 狀態變成 'isolated' 後，
   * 就不需要再繼續監聽了）。
   * ---------------------------------------------------------------------
   */
  once(eventName, listener) {
    const wrappedListener = (...args) => {
      this.off(eventName, wrappedListener);
      listener(...args);
    };
    return this.on(eventName, wrappedListener);
  }

  /**
   * off(eventName, listener)
   * ---------------------------------------------------------------------
   * 取消訂閱。若該事件底下已經沒有任何 listener，順手把整個 Set
   * 從 Map 中移除，避免 Map 裡累積大量「空 Set」造成記憶體浪費
   * （這在長時間運行的 SPA 頁面尤其重要，因為使用者可能反覆
   * 切換分頁、反覆訂閱又取消訂閱同一批事件）。
   * ---------------------------------------------------------------------
   */
  off(eventName, listener) {
    const listeners = this._listeners.get(eventName);
    if (!listeners) return;

    listeners.delete(listener);

    if (listeners.size === 0) {
      this._listeners.delete(eventName);
    }
  }

  /**
   * emit(eventName, ...args)
   * ---------------------------------------------------------------------
   * 觸發事件，依序同步呼叫所有訂閱者。
   *
   * 錯誤處理設計：
   * 用 try-catch 包住「每一個」listener 的執行，而不是整個迴圈外層包一次。
   * 原因：如果 A、B、C 三個模組都訂閱了同一個事件，A 的處理邏輯拋出例外，
   * 不應該連帶讓 B、C 都收不到這次的事件通知 —— 例如 ProgressGuard 和
   * ui-bridge.js 都訂閱了 'converter:progress'，就算其中一方的處理邏輯
   * 意外出錯，另一方仍然應該正常收到進度更新，才不會讓一個模組的 bug
   * 擴散成整個轉檔流程卡死。
   * ---------------------------------------------------------------------
   */
  emit(eventName, ...args) {
    const listeners = this._listeners.get(eventName);
    if (!listeners || listeners.size === 0) return;

    // 先複製成陣列再迭代：
    // 避免「某個 listener 執行時，又呼叫了 on()/off() 修改了同一個
    // Set」導致的迭代器狀態不一致問題（例如 listener 內部邏輯是
    // 「先取消訂閱自己，再訂閱另一個新的處理函式」）。
    Array.from(listeners).forEach((listener) => {
      try {
        listener(...args);
      } catch (err) {
        console.error(`[EventBus] 事件 "${eventName}" 的其中一個監聽器執行時發生錯誤：`, err);
      }
    });
  }

  /**
   * clear(eventName)
   * ---------------------------------------------------------------------
   * 清除某個事件的所有訂閱者；若不傳入 eventName，則清除全部事件的
   * 全部訂閱者。主要用於頁面卸載前的資源清理，或單元測試中每個
   * test case 開始前重置狀態，避免測試之間互相污染。
   * ---------------------------------------------------------------------
   */
  clear(eventName) {
    if (eventName === undefined) {
      this._listeners.clear();
    } else {
      this._listeners.delete(eventName);
    }
  }

  /**
   * listenerCount(eventName)
   * ---------------------------------------------------------------------
   * 主要供除錯或單元測試使用：回傳目前某個事件有多少個訂閱者。
   * ---------------------------------------------------------------------
   */
  listenerCount(eventName) {
    const listeners = this._listeners.get(eventName);
    return listeners ? listeners.size : 0;
  }
}

// -------------------------------------------------------------------------
// 匯出一個「全域單例（singleton）」，而不是讓每個模組各自 new EventBus()。
// 原因：EventBus 存在的目的就是讓不同模組（DeviceProfiler、WorkerLifecycle、
// ProgressGuard...）能夠互相溝通，若每個模組拿到的是不同實例，
// 彼此之間的 emit/on 就完全對不上，等於失去了「共用匯流排」的意義。
// 因此这里用「單例模式」：全專案 import 到的都是同一個物件參考。
// -------------------------------------------------------------------------
export const EventBus_instance = new EventBus();

// 同時也匯出 class 本身（非必要情境很少用到，主要保留給單元測試：
// 測試時可以 new EventBus() 建立一個「乾淨、互不干擾」的獨立實例，
// 而不必共用正式環境的全域單例，避免測試案例之間互相汙染狀態）。
export { EventBus };

/**
 * =============================================================================
 * 【bridgeToDom 已於 ui-bridge.js 全面改用 EventBus_instance 後移除】
 * =============================================================================
 * 這裡原本有一個 bridgeToDom(eventNames) 過渡期相容函式，用途是在
 * ui-bridge.js 尚未改造完成、仍依賴 document.addEventListener 監聽事件
 * 的階段，把 EventBus 上的事件同步轉發成 DOM CustomEvent。
 *
 * 現在 ui-bridge.js 已經全面改用 EventBus_instance.on() / .emit() 做
 * 雙向溝通，不再需要這層轉發，因此依照當初寫下的遷移計畫（見本檔案
 * 開頭的模組說明）將這個函式與其在 converter-core.js 內的呼叫處
 * 一併移除。若未來又有新的、暫時無法直接使用 EventBus 的消費端
 * （例如某個第三方套件只接受原生 DOM 事件），可以參考 git 歷史紀錄
 * 把這個函式復原，介面設計不需要改變。
 * =============================================================================
 */
