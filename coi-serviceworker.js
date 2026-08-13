/**
 * =============================================================================
 * coi-serviceworker.js
 * =============================================================================
 * 【檔案定位】
 * 這是一支「純 Service Worker 端」腳本，職責單一：攔截頁面發出的每一筆
 * fetch 請求，在回應上補上 Cross-Origin-Opener-Policy（COOP）與
 * Cross-Origin-Embedder-Policy（COEP）這兩個標頭。
 *
 * 【為什麼需要這支腳本】
 * FFmpeg.wasm（以及未來若要用到的其他需要 SharedArrayBuffer 的 Wasm
 * 套件）要求頁面必須處於「跨域隔離」（Cross-Origin Isolated）狀態，
 * 瀏覽器才會開放 SharedArrayBuffer 這個 API。跨域隔離需要伺服器端
 * 回傳 COOP/COEP 標頭，但 GitHub Pages 是純靜態託管，無法自訂
 * Response Header。這支 Service Worker 的作用就是在瀏覽器端「模擬」
 * 出這兩個標頭的效果，讓靜態網站也能滿足跨域隔離的條件。
 *
 * 【重要：本檔案是原創實作，非逐字複製任何既有專案】
 * 社群上有知名的開源方案（採用相同的技術原理：攔截 fetch、複製回應、
 * 補上標頭），但本檔案是依照相同的公開技術原理由本專案重新撰寫，
 * 邏輯與註解皆為原創。若未來要改用社群版本，只需要整份替換這個檔案，
 * index.html 裡的動態路徑註冊邏輯完全不需要改動（介面不變）。
 *
 * 【已知限制（誠實聲明，非隱藏風險）】
 * - 這裡只處理「同源請求」與「支援 CORS 的跨源請求」，若專案未來引入
 *   不支援 CORS 的第三方跨源資源（例如某些 CDN 若沒有回應正確的
 *   Access-Control-Allow-Origin），該資源的請求會被導向 no-cors 模式，
 *   COEP: require-corp 標頭會導致瀏覽器直接封鎖該資源載入。若未來
 *   真的需要載入這類資源，需要額外實作 credentialless 模式或改用
 *   有 CORS 支援的資源來源，本檔案目前先聚焦在讓 FFmpeg.wasm／
 *   本專案自身的靜態資源（HTML/JS/字型檔）能正常運作。
 * - 僅攔截 GET 請求（頁面資源載入的絕大多數情境），非 GET 請求
 *   （目前本專案沒有任何需要送出的 POST/PUT 請求）直接放行不處理。
 * =============================================================================
 */

/**
 * install 事件：Service Worker 第一次被瀏覽器安裝時觸發。
 *
 * 呼叫 self.skipWaiting() 的原因：預設情況下，新版 Service Worker
 * 安裝完成後會停留在 'waiting' 狀態，要等所有目前受舊版 SW 控制的分頁
 * 都關閉後才會真正啟用（activate）。但本專案只有這一份 SW，沒有「舊版
 * 與新版並存」的情境需要保護，若不呼叫 skipWaiting()，使用者初次造訪
 * 時可能要重新整理兩次以上才能讓 SW 生效，體驗不佳，因此直接跳過
 * 等待階段，安裝完成後立刻進入 activate 流程。
 */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

/**
 * activate 事件：Service Worker 準備開始接管頁面時觸發。
 *
 * 呼叫 self.clients.claim() 的原因：預設情況下，即使 SW 已經
 * activate，也只會控制「之後才載入」的新分頁，目前已經開啟的分頁
 * 仍然不受它控制，直到下次重新整理。clients.claim() 可以讓 SW
 * 立刻接管所有目前開啟中、同一個 scope 底下的分頁，減少使用者需要
 * 手動重新整理的次數（雖然本專案在 index.html 裡仍然安排了「首次
 * 註冊後重整一次」的保險機制，claim() 可以讓後續流程更順暢）。
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * fetch 事件：攔截頁面發出的每一筆網路請求，是這支檔案的核心邏輯。
 *
 * 處理流程：
 *   1. 非 GET 請求或明確不需要處理的請求類型，直接放行（不攔截）。
 *   2. 呼叫原本的 fetch() 取得真正的回應。
 *   3. 用新的 Headers 物件複製原回應的所有標頭，並「加上」COOP/COEP。
 *      之所以要用「複製後新建」而不是直接修改原 Response 物件的
 *      headers，是因為 Response.headers 在多數瀏覽器實作中是唯讀的，
 *      必須建構一個全新的 Response 物件才能改變標頭內容。
 *   4. 用 respondWith() 回傳這個補上標頭的新 Response，取代原本的回應。
 */
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 只處理 GET 請求：本專案目前所有資源（HTML/JS/字型檔/使用者上傳的
  // 檔案處理都在本機記憶體進行，沒有任何 POST/PUT 請求）都是 GET，
  // 非 GET 請求一律放行，避免不必要地攔截並可能破壞未來若新增的
  // 表單提交等功能。
  if (request.method !== 'GET') {
    return;
  }

  event.respondWith(
    (async () => {
      let response;
      try {
        response = await fetch(request);
      } catch (err) {
        // 網路請求本身失敗（例如離線、資源不存在），直接把錯誤往外拋，
        // 讓瀏覽器用它原生的失敗處理方式呈現（例如顯示網路錯誤頁面），
        // 不需要在這裡做額外的錯誤處理，因為這支 SW 的職責僅限於
        // 「補標頭」，不負責網路錯誤重試等邏輯。
        throw err;
      }

      // opaque 回應（通常是 no-cors 模式下的跨源請求結果）：瀏覽器基於
      // 安全考量，完全不允許 JS 讀取或複製這類回應的內容與標頭，
      // 強行複製會拋出例外。這種情況下只能原樣放行，代表這筆請求
      // 「無法」被補上 COEP 所需的標頭，若該資源確實需要被跨域隔離
      // 頁面載入，瀏覽器屆時會自行依照 COEP 規則決定是否封鎖，
      // 這正是上方「已知限制」提到的情境。
      if (response.type === 'opaque' || response.type === 'opaqueredirect') {
        return response;
      }

      const newHeaders = new Headers(response.headers);
      // Cross-Origin-Opener-Policy: same-origin
      // 確保本頁面的瀏覽情境群組（browsing context group）與其他來源
      // 的視窗（例如被 window.open() 開啟的外部網站）互相隔離，
      // 這是跨域隔離狀態的必要條件之一。
      newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
      // Cross-Origin-Embedder-Policy: require-corp
      // 要求頁面內嵌的每一項跨源資源都必須明確聲明允許被嵌入
      // （透過 CORP 標頭或 CORS），這是啟用 SharedArrayBuffer 的
      // 另一個必要條件。
      newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    })()
  );
});
