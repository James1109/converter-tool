/**
 * =============================================================================
 * ui-bridge.js
 * =============================================================================
 * 【模組定位】
 * 這支檔案是 UI 層與 converter-core 之間唯一的橋樑。規則只有一條，
 * 但必須嚴格遵守：
 *
 *     這裡只能有「DOM 操作」「事件監聽」「UI 狀態切換」，
 *     絕對不能出現任何轉檔演算法、Worker 建立、IndexedDB 存取等邏輯。
 *
 * 所有需要「真正做事」的地方，一律透過
 *   EventBus_instance.emit('converter:xxx', detail)
 * 把請求丟給 ConverterOrchestrator / WorkerLifecycle；
 * 所有需要「知道核心進度/結果」的地方，一律透過
 *   EventBus_instance.on('converter:xxx', handler)
 * 被動接收，絕不主動去 import 或呼叫 core 內部的業務函式
 * （只 import event-bus.js 這個純粹的溝通管道，不算違反此規則）。
 *
 * 【重要教訓 / 為什麼不能用 document.dispatchEvent】
 * 本檔案先前的版本是用 document.dispatchEvent(new CustomEvent(...)) 送出
 * 「UI → core」的事件，並靠 converter-core.js 裡的 bridgeToDom() 做
 * 「EventBus → DOM」的單向轉發，讓當時尚未改造的這支檔案還能收到
 * core 端的廣播。但 bridgeToDom() 只處理了「core → UI」這個方向；
 * ConverterOrchestrator、WorkerLifecycle 訂閱的是 EventBus_instance
 * 本身，不是 document，因此當時本檔案用 document.dispatchEvent 送出的
 * 'converter:start' / 'converter:cancel' 等事件，實際上完全沒有任何
 * 監聽者收到——這是一個容易被忽略的「單向橋接看起來像雙向」陷阱。
 * 現在全面改用 EventBus_instance 做雙向溝通，徹底移除這個陷阱，
 * 也讓 converter-core.js 不再需要 bridgeToDom() 這層過渡相容層。
 * =============================================================================
 */

import { EventBus_instance } from './event-bus.js';
import { detectProviderFromKey } from './ai-provider-detect.js';

// -------------------------------------------------------------------------
// 「文件轉檔」面板的來源／目標格式對照表。目前每個來源格式只對應一種
// 目標格式（純前端技術限制使然，見下方 initDocumentFormatSelectors()
// 的說明），但集中定義在這裡，未來要擴充新組合（例如 PDF → 文字、
// Word → HTML）只需要在這張表加一筆，不需要動其他程式碼。
// -------------------------------------------------------------------------
const DOCUMENT_TARGET_OPTIONS_BY_SOURCE = {
  pdf: [{ value: 'image', label: '圖片（PNG，每頁各一張）' }],
  docx: [{ value: 'pdf', label: 'PDF' }],
};

const DOCUMENT_DIRECTION_MAP = {
  'pdf->image': 'pdf-to-image',
  'docx->pdf': 'word-to-pdf',
};

// -----------------------------------------------------------------------
// 事件名稱常數：跟 device-profiler.js 一樣，集中定義避免字串打錯字。
// 「core → UI」與「UI → core」的方向在註解中明確標示，方便日後追蹤資料流。
// -----------------------------------------------------------------------
const EVENTS = {
  // ---- core → UI（監聽） ----
  DEVICE_READY: 'converter:device-ready',
  ISOLATION_STATUS: 'converter:isolation-status',
  MEMORY_RISK: 'converter:memory-risk',
  // 真正需要使用者確認才能繼續轉檔的阻擋型事件，跟上面那個純提示性
  // 質的 MEMORY_RISK 是兩個不同的時機點：MEMORY_RISK 在選檔當下觸發
  // （非阻擋橫幅），這個在使用者真正按下「開始轉檔」時才觸發
  // （阻擋型 Modal，等待使用者明確選擇才會繼續）。
  MEMORY_RISK_CONFIRM_REQUEST: 'converter:memory-risk-confirm-request',
  FILE_CHECK_RESULT: 'converter:file-check-result',
  PROGRESS: 'converter:progress',
  RESULT: 'converter:result',
  ERROR: 'converter:error',
  FONT_STATUS: 'converter:font-status',

  // ---- UI → core（送出） ----
  FILE_SELECTED: 'converter:file-selected',
  START: 'converter:start',
  CANCEL: 'converter:cancel',
  MEMORY_RISK_RESPONSE: 'converter:memory-risk-response',
  VIDEO_SOFT_WARNING_RESPONSE: 'converter:video-soft-warning-response',

  // ---- AI BYOK 設定（雙向，見 ai-key-manager.js）----
  AI_SETTINGS_SAVE: 'converter:ai-settings-save',     // UI → core
  AI_SETTINGS_REQUEST: 'converter:ai-settings-request', // UI → core
  AI_SETTINGS_STATUS: 'converter:ai-settings-status',   // core → UI

  // ---- GitHub 進階轉檔設定（雙向，見 github-settings-manager.js）----
  GH_SETTINGS_SAVE: 'converter:gh-settings-save',
  GH_SETTINGS_REQUEST: 'converter:gh-settings-request',
  GH_SETTINGS_STATUS: 'converter:gh-settings-status',
};

// -----------------------------------------------------------------------
// 模組內部狀態（僅限 UI 層的顯示狀態，例如「目前選到的分頁」「目前選到的
// 檔案」，這些屬於畫面互動狀態，不算「轉檔邏輯」，放在這裡是合理的）。
// -----------------------------------------------------------------------
const uiState = {
  currentTool: 'image', // 目前作用中的分頁：'image' | 'document' | 'video'
  selectedFiles: {
    image: null,
    document: null,
    video: null,
    audio: null,
    'ai-document': null,
    'gh-actions-document': null,
  },
};

// =========================================================================
// 區塊 A：共用小工具函式
// =========================================================================

/**
 * setElementDisabled(button, disabled)
 * -----------------------------------------------------------------------
 * 防禦性切換按鈕的 disabled 狀態。
 *
 * 為什麼不能只設定 button.disabled = true/false：
 * 部分瀏覽器（尤其是 Safari 少數版本、以及某些行動瀏覽器的 WebView）
 * 在用 JS 動態移除 disabled 屬性後，Tailwind 的 disabled: 系列偽類
 * 樣式不會立即重新計算，導致按鈕「邏輯上可點擊了，但視覺上看起來還是
 * 灰色的」，使用者會誤以為壞掉。因此這裡「手動同步」opacity-40 與
 * cursor-not-allowed 這兩個 class，不依賴 Tailwind 的 disabled: 偽類
 * 自動反應，確保樣式一定跟邏輯狀態一致。
 * -----------------------------------------------------------------------
 */
function setElementDisabled(button, disabled) {
  if (!button) return;
  button.disabled = disabled;
  button.classList.toggle('opacity-40', disabled);
  button.classList.toggle('cursor-not-allowed', disabled);
}

/** 顯示元素（移除 is-hidden） */
function showEl(el) {
  if (el) el.classList.remove('is-hidden');
}

/** 隱藏元素（加上 is-hidden） */
function hideEl(el) {
  if (el) el.classList.add('is-hidden');
}

/** 將 bytes 轉成好讀的 MB 字串，僅供畫面顯示使用 */
function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// =========================================================================
// 區塊 B：分頁（Tool Tabs）切換邏輯
// =========================================================================

function initToolTabs() {
  const tabButtons = document.querySelectorAll('.tool-tab-btn');
  const panels = document.querySelectorAll('.tool-panel');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      // 行動端已被鎖定的分頁（目前只有影音）不允許切換進去，
      // 直接跳出「行動端影音阻擋」Modal 提醒原因，而不是靜默無反應
      // （靜默無反應會讓使用者以為按鈕壞了，明確給出原因比較友善）。
      if (btn.disabled) {
        showModal('mobile-video-block');
        return;
      }

      const targetTool = btn.dataset.tool;
      uiState.currentTool = targetTool;

      // 切換分頁按鈕的視覺樣式（底線 + 文字顏色）
      tabButtons.forEach((otherBtn) => {
        const isActive = otherBtn === btn;
        otherBtn.classList.toggle('border-brand', isActive);
        otherBtn.classList.toggle('text-brand', isActive);
        otherBtn.classList.toggle('border-transparent', !isActive);
        otherBtn.classList.toggle('text-slate-500', !isActive);
        otherBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });

      // 切換對應的面板顯示（同一時間只顯示一個 panel）
      panels.forEach((panel) => {
        const isTarget = panel.dataset.panelFor === targetTool;
        panel.classList.toggle('is-hidden', !isTarget);
      });
    });
  });
}

// =========================================================================
// 區塊 C：拖曳上傳 / 檔案選擇邏輯
// =========================================================================

/**
 * updateDropzoneFileInfo(tool, file)
 * -----------------------------------------------------------------------
 * 在對應的拖曳區塊內動態插入（或更新）一行「已選擇：xxx（x.x MB）」文字，
 * 讓使用者拖曳/選擇檔案後能立刻在畫面上得到確認，而不是要等到「開始
 * 轉檔」或核心回報驗證結果才知道檔案有沒有被成功接收。
 *
 * 用 `.dropzone-selected-file-info` 這個 class 當作查找依據，若該區塊
 * 內已經存在（代表使用者重新選了另一個檔案），直接更新文字內容即可，
 * 不需要每次都重新建立新的 DOM 節點、造成不必要的節點堆積。
 * -----------------------------------------------------------------------
 */
function updateDropzoneFileInfo(tool, file) {
  const zone = document.querySelector(`.dropzone[data-tool="${tool}"]`);
  if (!zone) return;

  let infoEl = zone.querySelector('.dropzone-selected-file-info');
  if (!infoEl) {
    infoEl = document.createElement('p');
    infoEl.className = 'dropzone-selected-file-info text-xs text-brand font-medium mt-2';
    zone.appendChild(infoEl);
  }
  infoEl.textContent = `已選擇：${file.name}（${formatMB(file.size)}）`;
}

/**
 * handleFileChosen(tool, file)
 * -----------------------------------------------------------------------
 * 使用者選定檔案後的統一入口（不論是拖曳或點擊選擇檔案觸發，
 * 最終都會走到這裡）。
 *
 * 這裡「不」自己判斷檔案大小限制、記憶體風險等邏輯 ——
 * 那些屬於核心規則判斷，必須交給 DeviceProfiler / Orchestrator 處理。
 * ui-bridge.js 只負責：
 *   1. 記住這次選中的檔案（供之後點擊「開始轉檔」時取用）
 *   2. 把檔案丟給 core 端做驗證
 *   3. 啟用「開始轉檔」按鈕的「暫時」可點擊狀態
 *      （如果 core 端驗證後回報 'block'，按鈕會在
 *      FILE_CHECK_RESULT 的監聽器裡被重新鎖回 disabled）
 * -----------------------------------------------------------------------
 */
function handleFileChosen(tool, file) {
  if (!file) return;

  uiState.selectedFiles[tool] = file;

  // 立即給予視覺回饋，讓使用者確認檔案確實被接收，不需要等待核心的
  // 驗證結果回來才知道「選檔有沒有成功」。
  updateDropzoneFileInfo(tool, file);

  // 送出「檔案已選定」事件，讓 core 端（ConverterOrchestrator）
  // 根據 DeviceProfile 判斷這個檔案能不能轉、要不要跳警告。
  EventBus_instance.emit(EVENTS.FILE_SELECTED, { tool, file });

  // 先樂觀地啟用按鈕，讓使用者不會覺得選了檔案卻毫無反應；
  // 若 core 驗證後認定要阻擋，會在 FILE_CHECK_RESULT 監聽器裡改回 disabled。
  const startBtn = document.querySelector(`.start-convert-btn[data-tool="${tool}"]`);
  setElementDisabled(startBtn, false);
}

function initDropzones() {
  const dropzones = document.querySelectorAll('.dropzone');

  dropzones.forEach((zone) => {
    const tool = zone.dataset.tool;
    const fileInput = zone.querySelector('.file-input');

    // 點擊拖曳區塊 = 觸發隱藏的 file input 選擇檔案視窗
    zone.addEventListener('click', () => {
      fileInput.click();
    });

    // 透過傳統檔案選擇對話框選檔
    fileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      handleFileChosen(tool, file);
    });

    // ---- 拖曳互動：僅處理視覺回饋與檔案擷取，不做任何驗證邏輯 ----
    zone.addEventListener('dragover', (event) => {
      event.preventDefault(); // 必須阻止預設行為，否則瀏覽器會直接開啟檔案
      zone.classList.add('border-brand', 'bg-blue-50/40');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('border-brand', 'bg-blue-50/40');
    });

    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('border-brand', 'bg-blue-50/40');
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      handleFileChosen(tool, file);
    });
  });

  // ---- 「開始轉檔」按鈕：把目前分頁選定的檔案與選項一併送出 ----
  const startButtons = document.querySelectorAll('.start-convert-btn');
  startButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      const file = uiState.selectedFiles[tool];
      if (!file) return;

      const options = collectOptionsForTool(tool);

      EventBus_instance.emit(EVENTS.START, { tool, file, options });

      // 開始轉檔後，先鎖住按鈕避免使用者重複點擊送出同一個任務，
      // 真正的解鎖時機交給 RESULT / ERROR 事件的監聽器處理。
      setElementDisabled(btn, true);

      // ⭐ 防禦性修正 ⭐ 重置進度條視覺狀態（歸零寬度、換回預設文字），
      // 避免上一次任務結束時殘留的畫面（例如 100% 滿版）在這次新任務
      // 真正開始回報進度之前，被誤認為是這次任務的狀態。這個問題先前
      // 曾在 hasActiveWorker() 誤判導致任務提早被攔截的情境下被放大
      // 檢視出來：任務都還沒真的跑起來，畫面卻顯示著上一次的殘留進度，
      // 容易誤導使用者以為卡住。
      const progressTextEl = document.getElementById('progress-text');
      const progressFillEl = document.getElementById('progress-bar-fill');
      if (progressTextEl) progressTextEl.textContent = '正在處理中... (0%)';
      if (progressFillEl) progressFillEl.style.width = '0%';

      showEl(document.getElementById('progress-section'));
    });
  });
}

/**
 * collectOptionsForTool(tool)
 * -----------------------------------------------------------------------
 * 讀取各分頁面板上使用者選擇的轉檔選項（純粹讀 DOM 表單值，
 * 不涉及任何轉檔邏輯本身的判斷）。
 * -----------------------------------------------------------------------
 */
function collectOptionsForTool(tool) {
  if (tool === 'image') {
    return {
      format: document.getElementById('image-output-format').value,
      quality: Number(document.getElementById('image-quality').value),
    };
  }
  if (tool === 'document') {
    const sourceFormat = document.getElementById('document-source-format').value;
    const targetFormat = document.getElementById('document-target-format').value;
    return {
      direction: DOCUMENT_DIRECTION_MAP[`${sourceFormat}->${targetFormat}`] || 'word-to-pdf',
    };
  }
  if (tool === 'video') {
    return {
      format: document.getElementById('video-output-format').value,
    };
  }
  if (tool === 'audio') {
    return {
      format: document.getElementById('audio-output-format').value,
      bitrate: document.getElementById('audio-bitrate').value,
    };
  }
  if (tool === 'ai-document') {
    const modeInput = document.querySelector('input[name="ai-mode"]:checked');
    return {
      apiKey: document.getElementById('ai-api-key').value.trim(),
      mode: modeInput ? modeInput.value : 'lossless',
      customPrompt: document.getElementById('ai-custom-prompt').value.trim(),
      outputFormat: document.getElementById('ai-output-format').value,
    };
  }
  if (tool === 'gh-actions-document') {
    return {
      owner: document.getElementById('gh-owner').value.trim(),
      repo: document.getElementById('gh-repo').value.trim(),
      token: document.getElementById('gh-token').value.trim(),
    };
  }
  return {};
}

// =========================================================================
// 區塊 B-2：AI 文件處理面板（BYOK 金鑰輸入 + 模式切換）
// =========================================================================

/**
 * initAiSettingsPanel()
 * -------------------------------------------------------------------------
 * 職責：
 *   1. 自訂提示詞模式被選取時，才顯示 textarea（純畫面切換）。
 *   2. API Key 輸入框 / 「記住金鑰」勾選框變動時，透過 EventBus 把
 *      「儲存」意圖丟給 ai-key-manager.js，本身不碰 localStorage。
 *   3. 切換供應商（Gemini / OpenAI）時，重新向 core 查詢該供應商
 *      是否已有儲存的金鑰，並依回覆的 STATUS 事件回填欄位。
 *   4. 頁面載入時主動查詢一次目前選定供應商（預設 Gemini）的狀態，
 *      讓使用者不需要每次重新貼上金鑰。
 * -------------------------------------------------------------------------
 */
// =========================================================================
// 區塊 B-3：文件轉檔面板內的子模式切換（標準轉檔 / AI 智慧處理）
// =========================================================================

/**
 * initDocumentModeToggle()
 * -------------------------------------------------------------------------
 * 純畫面切換，不影響底層兩個 tool（'document' / 'ai-document'）各自
 * 獨立的驗證與轉檔邏輯——切換子模式只是決定「現在看得到哪一個
 * dropzone/開始按鈕」，兩邊各自選過的檔案（uiState.selectedFiles）
 * 仍然分開保留，切換回去不會遺失。
 * -------------------------------------------------------------------------
 */
/**
 * initDocumentFormatSelectors()
 * -------------------------------------------------------------------------
 * 「來源格式」下拉選單改變時，重新產生「目標格式」下拉選單的選項
 * （依 DOCUMENT_TARGET_OPTIONS_BY_SOURCE 這張表）。
 *
 * 為什麼目前每個來源格式只能對應一種目標格式：純前端環境下，
 * PDF→圖片靠的是 pdf.js 把每一頁畫到 canvas；Word→PDF 靠的是
 * mammoth.js 解析 + html2canvas 截圖。這兩條路徑用的函式庫完全不同，
 * 「PDF→Word」「圖片→PDF」這類組合各自需要另外的函式庫與邏輯，
 * 不是在畫面上多加一個選項就能生效的，之後要擴充需要一併補上對應的
 * Converter 實作，這裡只是先把「選來源、選目標」的 UI 骨架做好。
 * -------------------------------------------------------------------------
 */
function initDocumentFormatSelectors() {
  const sourceSelect = document.getElementById('document-source-format');
  const targetSelect = document.getElementById('document-target-format');
  if (!sourceSelect || !targetSelect) return;

  function refreshTargetOptions() {
    const options = DOCUMENT_TARGET_OPTIONS_BY_SOURCE[sourceSelect.value] || [];
    targetSelect.innerHTML = '';
    options.forEach(({ value, label }) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      targetSelect.appendChild(opt);
    });
  }

  sourceSelect.addEventListener('change', refreshTargetOptions);
  refreshTargetOptions(); // 頁面載入時先跑一次，確保目標格式選單一開始就有正確選項
}

function initDocumentModeToggle() {
  const standardBtn = document.getElementById('document-mode-standard-btn');
  const aiBtn = document.getElementById('document-mode-ai-btn');
  const standardSection = document.getElementById('document-mode-standard');
  const aiSection = document.getElementById('document-mode-ai');

  if (!standardBtn || !aiBtn) return;

  function setMode(mode) {
    const isAi = mode === 'ai';
    if (isAi) {
      showEl(aiSection);
      hideEl(standardSection);
    } else {
      showEl(standardSection);
      hideEl(aiSection);
    }
    // 用 class 而非 disabled 表達「目前選中」，維持跟其他分頁按鈕
    // 一致的視覺語言（白底 + 品牌色文字 = 使用中）。
    standardBtn.classList.toggle('bg-white', !isAi);
    standardBtn.classList.toggle('shadow-sm', !isAi);
    standardBtn.classList.toggle('text-brand', !isAi);
    standardBtn.classList.toggle('text-slate-500', isAi);
    aiBtn.classList.toggle('bg-white', isAi);
    aiBtn.classList.toggle('shadow-sm', isAi);
    aiBtn.classList.toggle('text-brand', isAi);
    aiBtn.classList.toggle('text-slate-500', !isAi);
  }

  standardBtn.addEventListener('click', () => setMode('standard'));
  aiBtn.addEventListener('click', () => setMode('ai'));
}

// =========================================================================
// 區塊 B-1b：進階轉檔（GitHub Actions）面板設定
// =========================================================================

function initGithubActionsSettingsPanel() {
  const ownerInput = document.getElementById('gh-owner');
  const repoInput = document.getElementById('gh-repo');
  const tokenInput = document.getElementById('gh-token');
  const rememberCheckbox = document.getElementById('gh-remember');

  if (!ownerInput || !repoInput || !tokenInput) return;

  function saveCurrentState() {
    EventBus_instance.emit(EVENTS.GH_SETTINGS_SAVE, {
      owner: ownerInput.value.trim(),
      repo: repoInput.value.trim(),
      token: tokenInput.value.trim(),
      remember: rememberCheckbox.checked,
    });
  }

  [ownerInput, repoInput, tokenInput].forEach((el) => el.addEventListener('change', saveCurrentState));
  rememberCheckbox.addEventListener('change', saveCurrentState);

  EventBus_instance.on(EVENTS.GH_SETTINGS_STATUS, ({ owner, repo, token, hasSettings }) => {
    if (!hasSettings) return;
    if (!ownerInput.value.trim()) ownerInput.value = owner;
    if (!repoInput.value.trim()) repoInput.value = repo;
    if (!tokenInput.value.trim()) tokenInput.value = token;
    rememberCheckbox.checked = true;
  });

  EventBus_instance.emit(EVENTS.GH_SETTINGS_REQUEST, {});
}

function initAiSettingsPanel() {
  const apiKeyInput = document.getElementById('ai-api-key');
  const rememberCheckbox = document.getElementById('ai-remember-key');
  const statusHint = document.getElementById('ai-key-status-hint');
  const detectHint = document.getElementById('ai-key-detect-hint');
  const customPromptTextarea = document.getElementById('ai-custom-prompt');
  const modeRadios = document.querySelectorAll('input[name="ai-mode"]');

  if (!apiKeyInput) return; // 面板未渲染時直接跳過，避免報錯

  // ---- 即時顯示「依金鑰字首判斷出來是哪個供應商」，純畫面提示，
  //       實際判斷邏輯（detectProviderFromKey）跟 AiDocumentConverter.js
  //       共用同一份 ai-provider-detect.js，避免顯示的判斷結果跟實際
  //       送出去的供應商兜不起來。這個判斷結果同時也決定「記住金鑰」
  //       要存到哪個供應商底下（見 saveCurrentKeyState()）。 ----
  function updateDetectHint() {
    const detected = detectProviderFromKey(apiKeyInput.value);
    if (!apiKeyInput.value.trim()) {
      detectHint.textContent = '';
    } else if (detected === 'gemini') {
      detectHint.textContent = '✅ 已自動判斷為 Google Gemini 金鑰。';
      detectHint.className = 'text-xs font-medium text-emerald-600';
    } else if (detected === 'openai') {
      detectHint.textContent = '✅ 已自動判斷為 OpenAI 金鑰。';
      detectHint.className = 'text-xs font-medium text-emerald-600';
    } else {
      detectHint.textContent = '⚠️ 無法辨識這個金鑰格式，請確認是否貼對了 Gemini 或 OpenAI 的 API Key。';
      detectHint.className = 'text-xs font-medium text-amber-600';
    }
    return detected;
  }
  apiKeyInput.addEventListener('input', updateDetectHint);

  // ---- 模式切換：只有 'custom' 才顯示自訂提示詞輸入框 ----
  modeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked && radio.value === 'custom') {
        showEl(customPromptTextarea);
      } else if (radio.checked) {
        hideEl(customPromptTextarea);
      }
    });
  });

  // ---- 儲存金鑰意圖：統一透過同一個函式送出，供多個事件來源共用。
  //       儲存的「供應商」一律依金鑰格式自動判斷，判斷不出來就不儲存
  //       （沒有下拉選單可以讓使用者手動指定要存去哪一個供應商底下了）。 ----
  function saveCurrentKeyState() {
    const detected = detectProviderFromKey(apiKeyInput.value);
    if (!detected) return;
    EventBus_instance.emit(EVENTS.AI_SETTINGS_SAVE, {
      provider: detected,
      apiKey: apiKeyInput.value.trim(),
      remember: rememberCheckbox.checked,
    });
  }

  apiKeyInput.addEventListener('change', saveCurrentKeyState);
  rememberCheckbox.addEventListener('change', saveCurrentKeyState);

  // ---- 接收 core 回報的金鑰狀態，回填欄位（僅在使用者尚未手動輸入
  //       新內容時才覆寫，避免打斷正在輸入的使用者） ----
  EventBus_instance.on(EVENTS.AI_SETTINGS_STATUS, ({ apiKey, hasKey }) => {
    if (apiKeyInput.value.trim()) return; // 使用者已經自己填了東西，不要蓋掉
    if (hasKey) {
      apiKeyInput.value = apiKey;
      rememberCheckbox.checked = true;
      statusHint.textContent = '已從本機讀取先前儲存的 API Key。';
      updateDetectHint();
    }
  });

  // ---- 頁面載入時依序查詢 Gemini、OpenAI 是否有已儲存的金鑰（沒有
  //       下拉選單可以讓使用者先指定要查哪一個了，兩個都查一次即可，
  //       哪個先回報有資料，欄位就先被哪個填上）。 ----
  EventBus_instance.emit(EVENTS.AI_SETTINGS_REQUEST, { provider: 'gemini' });
  EventBus_instance.emit(EVENTS.AI_SETTINGS_REQUEST, { provider: 'openai' });
}

// 圖片品質滑桿的即時數值顯示（純 UI 呈現，跟轉檔邏輯無關）
function initImageQualitySlider() {
  const slider = document.getElementById('image-quality');
  const valueLabel = document.getElementById('image-quality-value');
  slider.addEventListener('input', () => {
    valueLabel.textContent = `${slider.value}%`;
  });
}

// =========================================================================
// 區塊 D：監聽 converter:device-ready → 更新能力橫幅、鎖定影音分頁
// =========================================================================

function handleDeviceReady(profile) {
  const banner = document.getElementById('capability-banner');
  const bannerText = document.getElementById('capability-banner-text');

  const messages = [];

  // ---- 行動端：鎖定影音/音訊分頁 + 顯示阻擋 UI ----
  const videoTabBtn = document.querySelector('.tool-tab-btn[data-tool="video"]');
  const audioTabBtn = document.querySelector('.tool-tab-btn[data-tool="audio"]');
  if (profile.isMobileOrTablet) {
    setElementDisabled(videoTabBtn, true);
    videoTabBtn.title = '手機與平板裝置不支援影音轉檔功能';
    videoTabBtn.classList.add('opacity-40', 'cursor-not-allowed');

    setElementDisabled(audioTabBtn, true);
    audioTabBtn.title = '手機與平板裝置不支援音訊轉檔功能';
    audioTabBtn.classList.add('opacity-40', 'cursor-not-allowed');

    // 若使用者一開始就停留在影音/音訊面板（理論上預設是圖片分頁，但為了
    // 保險仍檢查），直接切換顯示阻擋訊息、隱藏原本的拖曳區。
    hideEl(document.getElementById('video-dropzone-wrapper'));
    showEl(document.getElementById('video-mobile-block'));
    hideEl(document.getElementById('audio-dropzone-wrapper'));
    showEl(document.getElementById('audio-mobile-block'));

    messages.push('偵測到行動裝置：影音與音訊轉檔功能已停用，僅開放圖片與 5MB 以內的小型文件轉檔。');
  }

  // ---- 行動端：文件轉檔顯示 5MB 限制提示 ----
  if (profile.documentLimit.mode === 'hard-limit') {
    showEl(document.getElementById('document-mobile-limit-hint'));
  }

  // ---- 桌面版 Safari：顯示硬性限制提示 ----
  if (profile.videoLimit.mode === 'hard-limit') {
    showEl(document.getElementById('video-safari-limit-hint'));
    messages.push(profile.videoLimit.message);
  }

  // ---- 桌面版 Chromium：柔性提醒門檻先告知，實際觸發要等使用者選檔 ----
  if (profile.videoLimit.mode === 'soft-warning') {
    messages.push(
      `目前使用 Chromium 系瀏覽器，影片超過 ${profile.videoLimit.maxSizeMB}MB 時會提示但仍可繼續轉檔。`
    );
  }

  // ---- 記憶體是估計值時，附註說明，避免使用者誤以為是精確數字 ----
  if (profile.memory.isEstimated) {
    messages.push(
      `（此瀏覽器不支援精確記憶體偵測，系統以 ${profile.memory.memoryGB}GB 作為保守估計）`
    );
  }

  if (messages.length > 0) {
    bannerText.textContent = messages.join('　');
    banner.classList.remove('is-hidden');
    // 依情況套用警告色：只要含有「阻擋」性質的訊息，就用較強烈的紅色系，
    // 否則使用較溫和的琥珀色系。
    const hasBlockingMessage = profile.isMobileOrTablet || profile.videoLimit.mode === 'hard-limit';
    banner.classList.toggle('bg-red-50', hasBlockingMessage);
    banner.classList.toggle('text-blocked', hasBlockingMessage);
    banner.classList.toggle('bg-amber-50', !hasBlockingMessage);
    banner.classList.toggle('text-warning', !hasBlockingMessage);
  } else {
    hideEl(banner);
  }
}

// =========================================================================
// 區塊 E：監聽 converter:isolation-status → 「安全沙盒初始化中」提示
// =========================================================================

/**
 * 這個 overlay 元素在 index.html 裡沒有預先寫死節點（因為它只在極少數
 * 「Service Worker 剛裝上、頁面即將自動重整」的過渡瞬間才會出現，
 * 停留時間通常不到一秒），因此改用 JS 動態建立、動態移除，
 * 避免在 HTML 裡放一個平常永遠用不到的節點。
 * 動態建立本身仍然屬於「DOM 操作」的範疇，符合 ui-bridge.js 的職責。
 */
let isolationOverlayEl = null;

function showIsolationOverlay() {
  if (isolationOverlayEl) return; // 避免重複建立

  isolationOverlayEl = document.createElement('div');
  isolationOverlayEl.className =
    'fixed inset-0 z-[60] bg-white/90 flex flex-col items-center justify-center gap-3';
  isolationOverlayEl.setAttribute('role', 'status');
  isolationOverlayEl.setAttribute('aria-live', 'polite');
  isolationOverlayEl.innerHTML = `
    <div class="h-8 w-8 border-4 border-brand border-t-transparent rounded-full animate-spin"></div>
    <p class="text-sm text-slate-600">正在初始化安全沙盒環境，請稍候...</p>
  `;
  document.body.appendChild(isolationOverlayEl);
}

function hideIsolationOverlay() {
  if (isolationOverlayEl) {
    isolationOverlayEl.remove();
    isolationOverlayEl = null;
  }
}

function handleIsolationStatus(detail) {
  const { status } = detail;

  if (status === 'reloading') {
    // 正常過渡狀態：coi-serviceworker.js 即將自動重新整理頁面，
    // 顯示載入動畫安撫使用者，不需要額外操作（重整會自然發生）。
    showIsolationOverlay();
  } else if (status === 'unavailable') {
    // 已重整過仍然無法隔離：這種環境下 SharedArrayBuffer 不可用，
    // FFmpeg.wasm 極可能無法運作，隱藏過渡動畫並在能力橫幅補充提示。
    hideIsolationOverlay();
    const bannerText = document.getElementById('capability-banner-text');
    const banner = document.getElementById('capability-banner');
    const existing = bannerText.textContent ? `${bannerText.textContent}　` : '';
    bannerText.textContent = `${existing}⚠️ 此環境無法啟用安全沙盒，影音轉檔功能可能無法使用。`;
    showEl(banner);
    banner.classList.add('bg-red-50', 'text-blocked');
  } else {
    // 'isolated'：一切正常，確保過渡動畫已經被移除。
    hideIsolationOverlay();
  }
}

// =========================================================================
// 區塊 F：記憶體風險的兩種不同時機處理
// =========================================================================

/**
 * showMemoryRiskInlineHint(detail)
 * -------------------------------------------------------------------------
 * 對應 'converter:memory-risk'，在使用者「選定檔案的當下」觸發
 * （converter-orchestrator.js 的 handleFileSelected() 呼叫
 * evaluateMemoryRisk() 時 emit）。這個時機點只是資訊性的提前告知，
 * 不需要打斷使用者，因此用跟裝置能力橫幅共用的區塊疊加一行提示文字，
 * 使用者可以直接無視、不需要任何回應就能繼續操作（例如調整轉檔選項、
 * 或直接點擊「開始轉檔」）。
 * -------------------------------------------------------------------------
 */
function showMemoryRiskInlineHint(detail) {
  const banner = document.getElementById('capability-banner');
  const bannerText = document.getElementById('capability-banner-text');

  const hintText = `⚠️ 偵測到檔案較大（約 ${detail.fileSizeMB}MB），裝置可用記憶體${detail.isMemoryEstimated ? '為估計值' : ''}約 ${detail.memoryGB}GB，轉檔過程中網頁可能會變慢或閃退。`;

  const existing = bannerText.textContent ? `${bannerText.textContent}　` : '';
  bannerText.textContent = `${existing}${hintText}`;
  showEl(banner);
}

function handleMemoryRisk(detail) {
  if (!detail.isRisky) return;
  showMemoryRiskInlineHint(detail);
}

/**
 * handleMemoryRiskConfirmRequest(detail)
 * -------------------------------------------------------------------------
 * 對應 'converter:memory-risk-confirm-request'，在使用者「真正按下
 * 開始轉檔」的當下才觸發（converter-orchestrator.js 的 handleStart()
 * 直接 emit，不經過 evaluateMemoryRisk()）。這是真正需要使用者明確
 * 回應「取消」或「仍要繼續」的阻擋型 Modal——使用者的選擇會透過
 * MODAL_CONFIRM_EVENTS 對照表（見下方區塊 K）送出
 * 'converter:memory-risk-response' 事件，讓 handleStart() 內的
 * await 恢復繼續執行或中止這次轉檔任務。
 * -------------------------------------------------------------------------
 */
function handleMemoryRiskConfirmRequest(detail) {
  showModal('memory-warning', detail);
}

// =========================================================================
// 區塊 G：監聽 converter:file-check-result → 影音/文件大小限制回饋
// =========================================================================

/**
 * core 端（未來的 Orchestrator）在收到 FILE_SELECTED 後，會依照
 * DeviceProfiler 算出的規則比對檔案大小，回報以下三種 action：
 *   - 'proceed'       → 一切正常，不需額外提示
 *   - 'warn-continue' → Chromium 柔性警告，顯示提示文字，但按鈕仍可點擊
 *   - 'block'         → 阻擋轉檔，鎖住按鈕並跳出對應 Modal
 */
function handleFileCheckResult(detail) {
  const { tool, action, message } = detail;
  const startBtn = document.querySelector(`.start-convert-btn[data-tool="${tool}"]`);

  if (action === 'block') {
    setElementDisabled(startBtn, true);
    if (tool === 'video') {
      // 依照目前 profile 狀態判斷是 Safari 硬性限制還是行動端阻擋，
      // 這裡簡單依訊息內容判斷 Modal 類型（更嚴謹的做法是讓 core
      // 直接回傳 modalType 欄位，未來接上 Orchestrator 時可以再優化）。
      const modalType = message && message.includes('Safari') ? 'safari-block' : 'mobile-video-block';
      showModal(modalType, { message });
    }
    return;
  }

  if (action === 'warn-continue' && tool === 'video') {
    const warningEl = document.getElementById('video-chromium-soft-warning');
    showEl(warningEl);
    // 柔性警告不鎖按鈕，使用者仍可直接點擊「開始轉檔」繼續。
    setElementDisabled(startBtn, false);
    return;
  }

  // 'proceed'：確保按鈕維持可點擊狀態。
  setElementDisabled(startBtn, false);
}

// =========================================================================
// 區塊 H：監聽 converter:progress → 更新進度條（防退演算法由 core 端負責，
//         這裡收到什麼數字就顯示什麼數字，絕不自己做任何「防退」判斷）
// =========================================================================

function handleProgress(detail) {
  const { percent, label } = detail;
  const progressText = document.getElementById('progress-text');
  const progressFill = document.getElementById('progress-bar-fill');

  const displayPercent = Math.round(percent * 10) / 10;
  progressText.textContent = `${label || '正在處理中...'} (${displayPercent}%)`;
  progressFill.style.width = `${displayPercent}%`;
}

// =========================================================================
// 區塊 I：監聽 converter:result → 顯示下載連結，並在下載後延遲釋放記憶體
// =========================================================================

/**
 * appendResultItem({ blobUrl, fileName, fileSizeBytes })
 * -------------------------------------------------------------------------
 * 插入單一筆「檔名 + 下載連結」到結果清單最上面（新結果一律插在
 * #result-list 最前面，而不是排在最後面），並且：
 *   - 把「上一筆的 NEW 標記」拿掉，只有最新這一筆會顯示 NEW
 *   - 附上刪除按鈕，讓使用者可以自行清掉不要的舊結果，刪除時一併
 *     呼叫 URL.revokeObjectURL() 真正釋放記憶體，不是只有從畫面上消失
 * 抽成獨立函式是因為現在有兩種呼叫情境：單一檔案結果（圖片/影音/
 * 文件）只需要呼叫一次；PDF 轉圖片的多頁輸出需要對 detail.files
 * 陣列裡的每一筆各自呼叫一次，重複使用同一段邏輯，避免兩處各寫一份
 * 容易產生行為不一致的風險。
 * -------------------------------------------------------------------------
 */
function appendResultItem({ blobUrl, fileName, fileSizeBytes }) {
  const resultList = document.getElementById('result-list');

  // 這一批新結果要插入之前，先把清單裡所有舊項目的 NEW 標記拿掉。
  resultList.querySelectorAll('.result-new-badge').forEach((badge) => badge.remove());

  const item = document.createElement('div');
  item.className = 'flex items-center justify-between text-sm bg-slate-50 rounded px-3 py-2 gap-2';

  const labelWrap = document.createElement('span');
  labelWrap.className = 'flex items-center gap-2 min-w-0';

  const badge = document.createElement('span');
  badge.className = 'result-new-badge shrink-0 text-[10px] font-bold bg-emerald-500 text-white px-1.5 py-0.5 rounded';
  badge.textContent = 'NEW';
  labelWrap.appendChild(badge);

  const label = document.createElement('span');
  label.className = 'truncate';
  label.textContent = `${fileName}（${formatMB(fileSizeBytes)}）`;
  labelWrap.appendChild(label);

  const actions = document.createElement('span');
  actions.className = 'flex items-center gap-3 shrink-0';

  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = fileName;
  link.textContent = '下載';
  link.className = 'text-brand font-medium hover:underline';

  // ---------------------------------------------------------------------
  // 下載觸發後延遲 1 秒呼叫 URL.revokeObjectURL()：
  // 不能在 click 事件當下「立即」revoke，因為瀏覽器觸發實際下載動作
  // 是非同步的，若立即釋放，部分瀏覽器（尤其是下載較大檔案時）可能
  // 來不及讀取 Blob 內容就已經被回收，導致下載失敗或檔案損毀。
  // 延遲 1 秒是業界常見的保守作法，足夠讓瀏覽器完成下載動作的初始化。
  // ---------------------------------------------------------------------
  let downloaded = false;
  link.addEventListener('click', () => {
    downloaded = true;
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 1000);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.textContent = '刪除';
  deleteBtn.className = 'text-slate-400 hover:text-red-500';
  deleteBtn.addEventListener('click', () => {
    // 已經下載過的話，上面那段延遲 1 秒的 revoke 應該已經處理過了，
    // 這裡再呼叫一次 revokeObjectURL 是安全的（對已釋放的 URL 重複呼叫
    // 不會出錯），避免使用者「還沒下載就直接按刪除」時記憶體沒被釋放。
    if (!downloaded) URL.revokeObjectURL(blobUrl);
    item.remove();
  });

  actions.appendChild(link);
  actions.appendChild(deleteBtn);

  item.appendChild(labelWrap);
  item.appendChild(actions);
  resultList.prepend(item);
}

function initClearResultsButton() {
  const clearBtn = document.getElementById('clear-results-btn');
  if (!clearBtn) return;
  clearBtn.addEventListener('click', () => {
    const resultList = document.getElementById('result-list');
    // 清空前逐一 revoke，避免使用者一次轉了很多檔案、清單裡累積一堆
    // 還沒下載的 blob URL，清除全部時卻只清畫面不釋放記憶體。
    resultList.querySelectorAll('a[href^="blob:"]').forEach((a) => URL.revokeObjectURL(a.href));
    resultList.innerHTML = '';
    hideEl(document.getElementById('result-section'));
  });
}

function handleResult(detail) {
  const { tool, files } = detail;

  hideEl(document.getElementById('progress-section'));
  if (inlineErrorBannerEl) hideEl(inlineErrorBannerEl); // 清除可能殘留的錯誤提示
  const resultSection = document.getElementById('result-section');
  showEl(resultSection);

  // 多檔案格式（目前只有 PDF 轉圖片的多頁輸出會用到）：detail.files
  // 是一個陣列，每一筆各自呼叫 appendResultItem()。
  // 單檔案格式（圖片／影音／Word 轉 PDF）：沿用原本的
  // { blobUrl, fileName, fileSizeBytes } 扁平結構，向下相容，不需要
  // 修改其他 Converter 的呼叫方式。
  if (Array.isArray(files)) {
    files.forEach(appendResultItem);
  } else {
    appendResultItem(detail);
  }

  // 轉檔完成，重新啟用該分頁的「開始轉檔」按鈕，讓使用者可以再轉下一個檔案。
  const startBtn = document.querySelector(`.start-convert-btn[data-tool="${tool}"]`);
  setElementDisabled(startBtn, uiState.selectedFiles[tool] == null);
}

/**
 * showInlineErrorBanner(message)
 * -------------------------------------------------------------------------
 * 用動態建立的錯誤橫幅取代原本的 window.alert()。
 * window.alert() 是瀏覽器原生的「阻斷式」對話框，會整個卡住頁面直到
 * 使用者按下確定，這跟本專案其餘地方一貫的「非阻斷、可以直接忽略
 * 繼續操作」設計風格不一致，也沒辦法自訂樣式。改成動態插入一個帶有
 * 關閉按鈕的紅色橫幅，插在 progress-section 下方、result-section
 * 上方，使用者可以直接點掉、也可以放著不管繼續操作其他功能。
 *
 * 用「動態建立、不重複建立」的做法（跟 isolationOverlayEl 的模式一致）：
 * 若已存在就直接更新文字內容並重新顯示，不會每次錯誤都疊加新的
 * DOM 節點造成畫面上出現一堆錯誤訊息疊在一起。
 * -------------------------------------------------------------------------
 */
let inlineErrorBannerEl = null;

function showInlineErrorBanner(message) {
  if (!inlineErrorBannerEl) {
    inlineErrorBannerEl = document.createElement('div');
    inlineErrorBannerEl.className =
      'flex items-start justify-between gap-3 bg-red-50 border border-blocked/30 text-blocked text-sm rounded-lg px-4 py-3 mt-4';
    inlineErrorBannerEl.setAttribute('role', 'alert');

    const textEl = document.createElement('span');
    textEl.className = 'inline-error-banner-text flex-1';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.className = 'text-blocked/60 hover:text-blocked font-bold flex-shrink-0';
    closeBtn.addEventListener('click', () => hideEl(inlineErrorBannerEl));

    inlineErrorBannerEl.appendChild(textEl);
    inlineErrorBannerEl.appendChild(closeBtn);

    // 插在 progress-section 之後，維持畫面由上到下「選項 → 進度 →
    // 錯誤/結果」的閱讀順序。
    const progressSection = document.getElementById('progress-section');
    progressSection.insertAdjacentElement('afterend', inlineErrorBannerEl);
  }

  inlineErrorBannerEl.querySelector('.inline-error-banner-text').textContent = message;
  showEl(inlineErrorBannerEl);
}

function handleError(detail) {
  const { tool, message } = detail;
  hideEl(document.getElementById('progress-section'));
  const startBtn = document.querySelector(`.start-convert-btn[data-tool="${tool}"]`);
  setElementDisabled(startBtn, uiState.selectedFiles[tool] == null);
  showInlineErrorBanner(message || '轉檔過程發生錯誤，請重新嘗試。');
}

// =========================================================================
// 區塊 J：監聽 converter:font-status → 字型下載中 Modal 的百分比更新
// =========================================================================

/**
 * status 可能的值：
 *   - 'downloading' → 顯示 Modal，percent 從 0 開始更新
 *   - 'progress'    → Modal 已顯示，僅更新 percent 數值
 *   - 'cached'      → 命中快取，完全不顯示任何提示（依規格 0 秒silent讀取）
 *   - 'error'       → 顯示字型快取錯誤 Modal，說明已自動清除重試
 */
function handleFontStatus(detail) {
  const { status, percent } = detail;
  const indicator = document.getElementById('font-status-indicator');

  if (status === 'downloading' || status === 'progress') {
    showModal('font-downloading', { percent: percent || 0 });
    // 同步在頁首的小型狀態指示器上也顯示簡短文字，
    // 讓使用者就算不小心關掉 Modal，仍能從頁首得知目前狀態。
    indicator.textContent = `字型下載中... ${Math.round(percent || 0)}%`;
    showEl(indicator);
  } else if (status === 'cached') {
    // 規格要求：命中快取時「不顯示任何提示」，因此這裡確保 Modal 與
    // 指示器都維持隱藏，即使先前曾經顯示過也要主動關閉。
    hideModal();
    hideEl(indicator);
  } else if (status === 'error') {
    showModal('font-cache-error');
    hideEl(indicator);
  } else if (status === 'ready') {
    // 下載完成、非快取命中的情境：短暫顯示完成訊息後關閉 Modal。
    hideModal();
    indicator.textContent = '字型已就緒';
    showEl(indicator);
    setTimeout(() => hideEl(indicator), 2000);
  }
}

/**
 * updateFontDownloadModalProgress(percent)
 * -----------------------------------------------------------------------
 * 專門處理字型下載 Modal 內的進度條寬度 + 標題百分比文字。
 * 依照需求：「動態在標題旁插入百分比文字」，這裡用 data-base-title
 * 記錄原始標題文字（不含百分比），每次更新時用「原始標題 + 百分比」
 * 重新組字串，避免重複串接造成「... 45% 60% 80%」疊加的錯誤。
 * -----------------------------------------------------------------------
 */
function updateFontDownloadModalProgress(percent) {
  const modal = document.querySelector('.modal-panel[data-modal-type="font-downloading"]');
  if (!modal) return;

  const titleEl = modal.querySelector('h3');
  const fillEl = modal.querySelector('#font-download-progress-fill');

  if (!titleEl.dataset.baseTitle) {
    // 第一次進來時，把「未含百分比」的原始標題存起來，供後續重組使用。
    titleEl.dataset.baseTitle = titleEl.textContent.trim();
  }

  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  titleEl.textContent = `${titleEl.dataset.baseTitle} ${clamped}%`;
  if (fillEl) {
    fillEl.style.width = `${clamped}%`;
  }
}

// =========================================================================
// 區塊 K：Modal 通用控制器 showModal(type, payload) / hideModal()
// =========================================================================

const modalRoot = () => document.getElementById('modal-root');

/**
 * MODAL_CONFIRM_EVENTS
 * -----------------------------------------------------------------------
 * 各 Modal 的「確認」按鈕被按下時，應該送出哪個事件給 core。
 * 只有 memory-warning 需要回報「使用者選擇是否要冒險繼續」，
 * 這個回覆會被 converter-orchestrator.js 的
 * waitForMemoryRiskConfirmation() 接收，決定要不要繼續往下呼叫
 * Converter。其餘 Modal（safari-block / mobile-video-block /
 * font-downloading / font-cache-error）的按鈕純粹只是「關閉提示」，
 * 不需要回報任何決策。
 * -----------------------------------------------------------------------
 */
const MODAL_CONFIRM_EVENTS = {
  'memory-warning': EVENTS.MEMORY_RISK_RESPONSE,
};

function showModal(type, payload = {}) {
  const root = modalRoot();
  const allPanels = root.querySelectorAll('.modal-panel');
  allPanels.forEach((panel) => hideEl(panel));

  const targetPanel = root.querySelector(`.modal-panel[data-modal-type="${type}"]`);
  if (!targetPanel) {
    console.warn(`[ui-bridge] 找不到對應的 Modal 類型：${type}`);
    return;
  }

  showEl(targetPanel);
  showEl(root);
  root.classList.remove('is-hidden');
  root.setAttribute('aria-hidden', 'false');
  root.dataset.activeModalType = type;

  // 字型下載 Modal 需要動態插入百分比文字
  if (type === 'font-downloading') {
    updateFontDownloadModalProgress(payload.percent || 0);
  }
}

function hideModal() {
  const root = modalRoot();
  hideEl(root);
  root.setAttribute('aria-hidden', 'true');
  delete root.dataset.activeModalType;
}

function initModalButtons() {
  const root = modalRoot();

  // 點擊半透明遮罩背景 = 等同按下取消（僅適用於非阻擋性質的提示，
  // 阻擋性質的 Modal 如 safari-block 理論上也可以這樣關閉，
  // 因為「關閉提示」本身不代表「解除限制」，限制仍然由 core 端把關）。
  root.querySelector('[data-modal-backdrop]').addEventListener('click', () => {
    hideModal();
  });

  root.querySelectorAll('.modal-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const activeType = root.dataset.activeModalType;
      // 若此 Modal 類型有對應的回報事件，取消也要回報 confirmed: false，
      // 讓 core 端知道使用者放棄了這次的風險確認，而不是卡住等待。
      const eventName = MODAL_CONFIRM_EVENTS[activeType];
      if (eventName) {
        EventBus_instance.emit(eventName, { confirmed: false });
      }
      hideModal();
    });
  });

  root.querySelectorAll('.modal-confirm-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const activeType = root.dataset.activeModalType;
      const eventName = MODAL_CONFIRM_EVENTS[activeType];
      if (eventName) {
        EventBus_instance.emit(eventName, { confirmed: true });
      }
      hideModal();
    });
  });
}

// =========================================================================
// 區塊 L：取消轉檔按鈕
// =========================================================================

function initCancelButton() {
  const cancelBtn = document.getElementById('progress-cancel-btn');
  cancelBtn.addEventListener('click', () => {
    const tool = uiState.currentTool;

    // 這裡只負責「送出取消意圖」，至於圖片/文件 Worker 該直接
    // terminate()、還是影音 Worker 該用 postMessage 送出優雅中斷訊號，
    // 那是 WorkerLifecycle 的職責範圍，ui-bridge.js 不需要也不應該
    // 知道底層是怎麼實作取消的。
    EventBus_instance.emit(EVENTS.CANCEL, { tool });
    hideEl(document.getElementById('progress-section'));

    // ---------------------------------------------------------------
    // 修正 QA 回報的狀態死鎖問題：
    // 使用者點擊「開始轉檔」時，我們在 initDropzones() 裡把按鈕鎖成
    // disabled，原本預期只有 RESULT / ERROR 事件觸發時才會解鎖。
    // 但使用者若在轉檔過程中按下「取消」，RESULT / ERROR 事件根本
    // 不會發生，按鈕就會永久卡在灰色鎖死狀態，使用者必須重新整理
    // 頁面才能再次轉檔 —— 這是明顯的 UX 死鎖。
    // 因此取消當下就要立即重新檢查「該分頁目前是否仍有選定的檔案」，
    // 若有（使用者可能想重新用同一個檔案再試一次），就直接解鎖按鈕；
    // 若沒有（例如檔案是透過某種方式被清空），則維持 disabled。
    // ---------------------------------------------------------------
    const startBtn = document.querySelector(`.start-convert-btn[data-tool="${tool}"]`);
    setElementDisabled(startBtn, uiState.selectedFiles[tool] == null);
  });
}

// =========================================================================
// 區塊 M：初始化進入點
// =========================================================================

function initUiBridge() {
  initToolTabs();
  initDropzones();
  initImageQualitySlider();
  initDocumentFormatSelectors();
  initDocumentModeToggle();
  initAiSettingsPanel();
  initGithubActionsSettingsPanel();
  initModalButtons();
  initCancelButton();
  initClearResultsButton();

  // ---- 綁定所有「core → UI」事件監聽（全面改用 EventBus_instance）----
  EventBus_instance.on(EVENTS.DEVICE_READY, handleDeviceReady);
  EventBus_instance.on(EVENTS.ISOLATION_STATUS, handleIsolationStatus);
  EventBus_instance.on(EVENTS.MEMORY_RISK, handleMemoryRisk);
  EventBus_instance.on(EVENTS.MEMORY_RISK_CONFIRM_REQUEST, handleMemoryRiskConfirmRequest);
  EventBus_instance.on(EVENTS.FILE_CHECK_RESULT, handleFileCheckResult);
  EventBus_instance.on(EVENTS.PROGRESS, handleProgress);
  EventBus_instance.on(EVENTS.RESULT, handleResult);
  EventBus_instance.on(EVENTS.ERROR, handleError);
  EventBus_instance.on(EVENTS.FONT_STATUS, handleFontStatus);
}

// DOMContentLoaded 才開始綁定，確保 index.html 裡所有節點都已經存在，
// 避免 querySelector 在腳本執行當下抓不到還沒解析完成的 DOM 節點。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUiBridge);
} else {
  initUiBridge();
}
