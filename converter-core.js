/**
 * =============================================================================
 * converter-core.js（正式核心中樞）
 * =============================================================================
 * 本檔案是整個 core 端的組裝入口（composition root）：負責依正確順序
 * import 各個模組並啟動裝置剖繪與業務調度器。本身不包含任何業務邏輯，
 * 純粹是「把積木組起來」的角色。
 *
 * 已完成並接上的模組：
 *   ✅ EventBus（純 Pub/Sub 匯流排，是 core ↔ UI 唯一的溝通管道）
 *   ✅ DeviceProfiler（裝置/瀏覽器判定、記憶體評估、跨域隔離偵測）
 *   ✅ WorkerLifecycle（Worker 建立/終止策略，模組載入時就會自動訂閱
 *      'converter:cancel' 事件，不需要在這裡額外呼叫任何初始化函式）
 *   ✅ ProgressGuard（進度防退 + 90% 後偽裝節流，介於各 Converter 與
 *      UI 之間，訂閱 'converter:progress-raw'、emit 真正的
 *      'converter:progress'）
 *   ✅ ffmpeg-engine.js（共用引擎：VideoConverter 與 AudioConverter
 *      共用同一個 @ffmpeg/ffmpeg 0.11.x 實例與「忙碌中」狀態，避免
 *      兩種任務同時搶用同一個 Wasm 實例；改在主執行緒直接執行——
 *      0.12.x 版本與獨立 Worker 架構在實測環境下皆有無法解決的問題，
 *      詳見該檔案頂端的架構例外說明）
 *   ✅ VideoConverter（真實可用，MP4/WebM/GIF，GIF 採兩階段調色盤
 *      最佳化）
 *   ✅ AudioConverter（真實可用，MP3/WAV/OGG，支援位元率調整）
 *   ✅ ImageConverter（真實可用，使用 OffscreenCanvas 實作圖片格式
 *      轉換，即用即丟 Worker 策略）
 *   ✅ PdfConverter（真實可用：'word-to-pdf' 使用開源 mammoth.js +
 *      pdf-lib + @pdf-lib/fontkit，走即用即丟 Worker 策略；
 *      'pdf-to-image' 使用開源 pdf.js，改在主執行緒直接執行並支援
 *      多頁輸出，詳見該檔案頂端的架構例外說明）
 *   ✅ FontCacheManager（IndexedDB 中文字型快取，懶載入：只在使用者
 *      真正進行文件轉檔時才觸發下載，見該檔案內的設計決策說明）
 *   ✅ ConverterOrchestrator（監聽 'converter:start'／
 *      'converter:file-selected'，依 tool 分流到對應 Converter，
 *      並在 'converter:start' 時真正攔截記憶體風險確認流程）
 *   ✅ ui-bridge.js（全面改用 EventBus_instance，雙向溝通已打通；
 *      錯誤提示改用非阻斷式畫面橫幅，不再使用 window.alert()）
 *
 * 尚待未來完成的部分：
 *   ⏳ font-cache-manager.js 內的 FONT_URL 需要替換成實際部署後的
 *      真正 TTF/OTF 字型檔案路徑（目前是佔位測試檔案，非合法字型格式）
 *   ⏳ FFmpeg 取消機制受限於 @ffmpeg/ffmpeg 目前的 API，取消後會重新
 *      初始化引擎（見 VideoConverter.js 內的說明），並非完全無成本的
 *      優雅中斷
 *   ⏳ GIF 輸出目前是單階段濾鏡轉換，色彩品質有進一步優化空間
 *      （兩階段調色盤最佳化：palettegen + paletteuse）
 *   ⏳ 行動端／Safari 限制邏輯僅完成程式邏輯撰寫，尚未在真實行動裝置
 *      與 Safari 瀏覽器上實機驗證過
 * =============================================================================
 */

import { initDeviceProfiler } from './device-profiler.js';
import { initConverterOrchestrator } from './converter-orchestrator.js';
import { initProgressGuard } from './progress-guard.js';
import { initAiKeyManager } from './ai-key-manager.js';
import { initGithubSettingsManager } from './github-settings-manager.js';

// -----------------------------------------------------------------------
// 步驟一：啟動 ConverterOrchestrator，讓它開始監聽 'converter:start'。
//
// 必須排在 initDeviceProfiler() 之前：雖然 Orchestrator 內部快取
// DeviceProfile 的訂閱邏輯（EventBus_instance.on('converter:device-ready', ...)）
// 其實在 import 當下（模組頂層程式碼執行時）就已經生效，跟這裡呼叫
// initConverterOrchestrator() 的時機無關；但仍然把「所有事件監聽器
// 就緒」這件事，整體排在「開始有任何事件可能被 emit」之前，
// 是比較不容易出錯的撰寫順序，日後回頭看這支檔案也一目了然。
// -----------------------------------------------------------------------
initConverterOrchestrator();
initProgressGuard();
initAiKeyManager();
initGithubSettingsManager();

// -----------------------------------------------------------------------
// 步驟二：執行裝置剖繪。
// 此時 ConverterOrchestrator（連帶其 import 鏈上的 WorkerLifecycle、
// VideoConverter）與 ui-bridge.js 的 EventBus 監聽器都已經就緒，
// initDeviceProfiler() 內部 emit 的 'converter:device-ready' /
// 'converter:isolation-status' 才能被完整接收，不會漏接。
// -----------------------------------------------------------------------
const deviceProfile = initDeviceProfiler();

if (typeof window !== 'undefined') {
  // 僅供開發階段在瀏覽器 Console 手動檢查用：
  // 輸入 window.__DEV_DEVICE_PROFILE__ 即可看到完整剖繪結果。
  window.__DEV_DEVICE_PROFILE__ = deviceProfile;
}

// -----------------------------------------------------------------------
// 步驟三：目前已無任何「UI → core」事件屬於待實作狀態。
//
// 'converter:start'、'converter:cancel'、'converter:file-selected' 都有
// 真正的處理邏輯（分別由 ConverterOrchestrator 與 WorkerLifecycle
// 負責）；'converter:memory-risk-response' 依照產品決策（記憶體風險
// 一律不攔截轉檔流程，僅顯示非阻擋性質的提示文字，見
// ui-bridge.js 的 showMemoryRiskInlineHint()），核心端不需要消費這個
// 事件，因此這裡不再保留任何除錯監聽清單。
// -----------------------------------------------------------------------
