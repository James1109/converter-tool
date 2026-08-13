/**
 * =============================================================================
 * converters/AiDocumentConverter.js
 * =============================================================================
 * 【模組定位】
 * 「🔥 核心特色：AI 輔助文件轉檔與處理」的實作本體，tool 名稱為
 * 'ai-document'。與既有的 PdfConverter（'document' tool，走
 * mammoth.js + pdf-lib 的「無 AI、確定性排版」路線）是兩條並存的
 * 平行管線，刻意不合併：
 *   - 'document'    → 適合「排版規則單純、要求 100% 忠實」的檔案，
 *                      不需要金鑰、不需要網路呼叫第三方 AI。
 *   - 'ai-document' → 適合「原始 Word 排版混亂、想要 AI 校對/整理/
 *                      客製化處理」的檔案，需要使用者自備 API Key。
 *
 * 【資料流向與隱私】
 * 檔案內容只會流向兩個地方：(1) 瀏覽器本機記憶體中的 mammoth.js 解析
 * 結果 (2) 使用者自己填入金鑰所對應的 AI 官方端點（Gemini 或
 * OpenAI）。全程不經過任何本專案的伺服器——因為本專案沒有伺服器。
 *
 * 【架構規則】
 * 本模組屬於 core 層，嚴禁出現 document.* / DOM 操作，只透過
 * EventBus_instance.emit() 對外廣播 'converter:progress-raw' /
 * 'converter:result' / 'converter:error'，與其他 Converter 完全一致。
 * =============================================================================
 */

import { EventBus_instance } from '../event-bus.js';
import { getStoredKey } from '../ai-key-manager.js';
import { registerMainThreadTask, clearMainThreadTask } from '../worker-lifecycle.js';
import { extractDocxHtml } from '../mammoth-extract.js';
import { renderHtmlToPdfBlob } from '../html-to-pdf-renderer.js';
import { extractDocxPageSetup } from '../docx-page-setup.js';
import { countUnsupportedSmartArt, buildSmartArtWarningHtml } from '../docx-content-audit.js';
import { renderAllSmartArtToHtml } from '../docx-smartart-render.js';
import { detectProviderFromKey } from '../ai-provider-detect.js';

// -------------------------------------------------------------------------
// 各 AI 供應商的端點與模型設定集中放在這裡，未來要換模型/版本只需要改這裡。
// 兩者皆為官方文件記載、允許瀏覽器端直接以 fetch() 呼叫（無需自建代理）的
// 端點：Gemini 用 URL query string 帶金鑰，OpenAI 用 Authorization header。
// -------------------------------------------------------------------------
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    model: 'gemini-2.5-flash',
    buildUrl: (apiKey, model) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
  },
  openai: {
    label: 'OpenAI',
    model: 'gpt-4o-mini',
    buildUrl: () => 'https://api.openai.com/v1/chat/completions',
  },
};

// -------------------------------------------------------------------------
// 三大處理模式的系統提示詞。刻意把「絕對不可刪減文字」這條規則在
// 模式一裡重複強調兩次、且放在提示詞最前與最後（AI 對長提示詞的
// 頭尾兩端遵從度通常較高），降低模型「順手幫使用者精簡內容」的機率。
// -------------------------------------------------------------------------
const MODE_PROMPTS = {
  lossless: (sourceHtml) => `你是一個嚴謹的文件格式排版工具，不是編輯或校對者。
【最高原則，優先於其他任何指示】絕對不可以刪減、遺漏、改寫、精簡、翻譯或修改任何一個原始文字、數字或標點符號。你唯一的工作是把下面這段從 Word 文件解析出來的 HTML 內容，整理成排版乾淨、結構清晰的繁體中文 HTML 文件（可以調整標籤、加上適當的 <h1>~<h3>、<p>、<ul>/<ol>、<table> 結構，讓視覺呈現更美觀），但文字內容必須逐字保留，一字不漏。
只回傳最終的 HTML（從 <body> 內部內容開始，不要包含 <html>/<head>/<body> 外層標籤，也不要用 \`\`\` 包裹），不要有任何說明文字。開頭第一個標籤就必須是有實際內容的標題或段落，結尾最後一個標籤也必須是有實際內容的段落，不要在開頭或結尾加入任何空白段落、空白 <div>、多餘的 <br> 或裝飾用的間距元素。
再次強調：不可刪減、遺漏或修改任何原始文字。

原始文件內容如下：
${sourceHtml}`,

  polish: (sourceHtml) => `你是一位專業的中文文件編輯。請閱讀下面這段從 Word 文件解析出來的 HTML 內容，完成以下工作，且無論原文本身讀起來通不通順，都必須確實做出看得出來的改善，不能只是原封不動照抄一遍：
1. 修正錯別字與標點符號誤用（就算原文已經很工整，也要仔細抓一遍）。
2. 逐句潤飾語句，讓表達更精煉、專業、口語化的部分改寫成正式書面語，不要整段照抄原文的句子。
3. 重新設計整體結構：加上清楚的標題階層（<h1>~<h3>）、用條列（<ul>/<ol>）取代原本用括號編號寫成一整句的內容、用 <strong> 標出關鍵詞或關鍵步驟名稱，讓人一眼就能抓到重點。
4. 在文件最開頭加一段 2-3 句的摘要（用 <p>，可以用 <strong> 開頭標註「摘要」），簡述這份文件在講什麼。
請保留原意與所有事實內容，不要新增原文沒有的資訊，但表達方式、結構、標題全部都要重新設計過，不能是原文的簡單複製。
只回傳最終的 HTML（從 <body> 內部內容開始，不要包含 <html>/<head>/<body> 外層標籤，也不要用 \`\`\` 包裹），不要有任何說明文字。開頭第一個標籤就必須是有實際內容的標題或段落，結尾最後一個標籤也必須是有實際內容的段落，不要在開頭或結尾加入任何空白段落、空白 <div>、多餘的 <br> 或裝飾用的間距元素。

原始文件內容如下：
${sourceHtml}`,

  custom: (sourceHtml, customPrompt) => `你會收到一段從 Word 文件解析出來的 HTML 內容，以及使用者的指令。請依照使用者指令處理這份內容，並將結果排版成清晰的 HTML。
只回傳最終的 HTML（從 <body> 內部內容開始，不要包含 <html>/<head>/<body> 外層標籤，也不要用 \`\`\` 包裹），不要有任何說明文字。開頭第一個標籤就必須是有實際內容的標題或段落，不要在開頭加入任何空白段落、空白 <div>、多餘的 <br> 或裝飾用的間距元素。

使用者指令：
${customPrompt}

原始文件內容如下：
${sourceHtml}`,
};

// -------------------------------------------------------------------------
// isBusy 狀態旗標 + 目前任務的 AbortController，供 handleCancel 中斷
// fetch，並讓 ConverterOrchestrator 的重複提交防禦可以查詢忙碌狀態
// （與 PdfConverter.isBusy() / VideoConverter.isBusy() 是同一種慣例）。
// -------------------------------------------------------------------------
let busy = false;
let activeAbortController = null;

// -------------------------------------------------------------------------
// 安全瓣（watchdog）：任何一次任務最長給 3 分鐘。實測發現 html2pdf.js
// 內部（html2canvas 截圖階段）在少數情況下可能因為畫面外容器量測異常
// 而卡住不resolve也不reject，若沒有這道保險，busy 旗標會永遠卡在
// true，導致「已有一個任務正在執行中」的訊息永久出現、使用者必須重新
// 整理頁面才能恢復。這裡用 Promise.race 讓逾時本身也視為一種錯誤結果，
// 統一走 finally 清理流程。
// -------------------------------------------------------------------------
const TASK_TIMEOUT_MS = 3 * 60 * 1000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}逾時（超過 ${Math.round(ms / 1000)} 秒未回應），已自動中止，請重新嘗試。`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function isBusy() {
  return busy;
}

function emitProgress(percent, label) {
  EventBus_instance.emit('converter:progress-raw', { tool: 'ai-document', percent, label });
}

function emitError(message) {
  EventBus_instance.emit('converter:error', { tool: 'ai-document', message });
}

/** 把 mammoth 輸出的 HTML 裡常見的 code fence 包裹（AI 有時仍會不聽話加上）剝除。 */
function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

/**
 * stripLeadingTrailingBlankBlocks(html)
 * -------------------------------------------------------------------------
 * ⭐ 修正「PDF 第一頁最上面有一大塊空白」的 bug ⭐
 * 實測發現 AI 回傳的 HTML 開頭常常帶著幾個「看起來是空的」區塊——
 * 空的 <p></p>、只有 &nbsp; 或 <br> 的段落——這在一般網頁裡幾乎看不
 * 出差異，但每一個空段落都會依 CSS line-height 佔掉一行的垂直空間，
 * 疊個五、六個空段落，截圖出來就是一大塊看似「無中生有」的空白，
 * 使用者在瀏覽器裡憑肉眼很難第一時間發現「原來是很多個看不見的空
 * 段落疊出來的」。這裡在渲染前用簡單的正規表示式，把開頭／結尾連續
 * 出現的空區塊清掉，是不依賴 AI 是否確實遵守提示詞指示的最後一道
 * 防線（提示詞裡雖然也加了「不要加多餘空白」的指示，但不能保證
 * 100% 遵守，程式碼層面的防呆比較可靠）。
 * -------------------------------------------------------------------------
 */
function stripLeadingTrailingBlankBlocks(html) {
  const isBlankBlock = /^\s*<(p|div)[^>]*>\s*(&nbsp;|<br\s*\/?>)*\s*<\/\1>\s*/i;
  const isLoneBr = /^\s*<br\s*\/?>\s*/i;

  let result = html.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const blockMatch = result.match(isBlankBlock);
    if (blockMatch) {
      result = result.slice(blockMatch[0].length);
      changed = true;
      continue;
    }
    const brMatch = result.match(isLoneBr);
    if (brMatch) {
      result = result.slice(brMatch[0].length);
      changed = true;
    }
  }
  return result.trim();
}

/**
 * callAiProvider(provider, apiKey, prompt, mode, signal)
 * -------------------------------------------------------------------------
 * 依供應商呼叫對應的官方 REST API。兩者回傳格式不同，這裡統一整理成
 * 單純的字串（AI 回傳的 HTML 內容）回傳給呼叫端。
 * -------------------------------------------------------------------------
 */
async function callAiProvider(provider, apiKey, prompt, mode, signal) {
  const config = PROVIDERS[provider];
  if (!config) {
    throw new Error(`未知的 AI 供應商：${provider}`);
  }

  // ⭐ 修正「智慧整理與修飾模式看起來像沒作用」的問題 ⭐
  // 上一版為了修「內容被截斷」的 bug，把 thinkingBudget 一律設為 0
  // （完全關閉思考），這對「完整忠實轉寫」模式是對的（這個模式本來
  // 就只需要照抄格式，不需要思考，關閉思考還能避免 AI 自作主張亂改
  // 內容）。但「AI 智慧整理與修飾」「自訂提示詞」這兩個模式的任務
  // 本質是「判斷哪裡該潤飾、怎麼重新組織」，這需要一定程度的推理，
  // 完全關閉思考會讓模型變得過度保守、幾乎只是照抄一遍，使用者會
  // 感覺「AI 好像沒作用到」。
  // 這裡改成依模式給不同的思考額度：lossless 維持 0（不推理、不改
  // 內容），polish/custom 給一個有限額度（讓它有空間思考怎麼改寫，
  // 但不會多到又把輸出額度吃光導致截斷）。maxOutputTokens 也調高，
  // 確保「思考額度 + 實際輸出內容」兩者相加後還有充裕空間。
  const thinkingBudget = mode === 'lossless' ? 0 : 4096;
  const temperature = mode === 'lossless' ? 0.1 : 0.7;

  if (provider === 'gemini') {
    const response = await fetch(config.buildUrl(apiKey, config.model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 65536,
          temperature,
          thinkingConfig: { thinkingBudget },
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Gemini API 呼叫失敗（HTTP ${response.status}）：請確認 API Key 是否正確或額度是否足夠。${errBody ? ' ' + errBody.slice(0, 200) : ''}`);
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text) {
      throw new Error('Gemini API 未回傳任何內容，可能是輸入內容觸發了安全過濾機制，請嘗試縮短文件或更換內容。');
    }
    if (candidate?.finishReason === 'MAX_TOKENS') {
      // 就算調高了額度還是被截斷（極端長文件），寧可明確告訴使用者
      // 「內容不完整」，也不要默默把一份斷尾的結果當成功交出去。
      throw new Error('文件內容過長，AI 回應在產生到一半時被截斷（超出單次處理上限）。請嘗試將文件拆成較短的段落分次處理，或改用「完整忠實轉寫」以外較精簡的模式。');
    }
    return stripCodeFence(text);
  }

  // provider === 'openai'
  const response = await fetch(config.buildUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 16384,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenAI API 呼叫失敗（HTTP ${response.status}）：請確認 API Key 是否正確或額度是否足夠。${errBody ? ' ' + errBody.slice(0, 200) : ''}`);
  }

  const data = await response.json();
  const choice = data?.choices?.[0];
  const text = choice?.message?.content || '';
  if (!text) {
    throw new Error('OpenAI API 未回傳任何內容，請稍後再試。');
  }
  if (choice?.finish_reason === 'length') {
    throw new Error('文件內容過長，AI 回應在產生到一半時被截斷（超出單次處理上限）。請嘗試將文件拆成較短的段落分次處理。');
  }
  return stripCodeFence(text);
}

/**
 * start(file, options)
 * -------------------------------------------------------------------------
 * options 結構：
 *   {
 *     provider: 'gemini' | 'openai' | 'auto',  // 'auto' = 依金鑰字首判斷
 *     apiKey: string,           // 由 UI 表單即時讀取，未必等於已儲存的值
 *     mode: 'lossless' | 'polish' | 'custom',
 *     customPrompt: string,     // 僅 mode === 'custom' 時使用
 *   }
 * -------------------------------------------------------------------------
 */
export async function start(file, options) {
  if (busy) return;

  const apiKey = (options.apiKey || '').trim();

  // ⭐ 供應商自動判斷：優先依金鑰字首判斷（"AIza" → Gemini，
  // "sk-" → OpenAI），這樣使用者只要貼上金鑰就好，不用擔心
  // 選錯下拉選單送錯端點（400 Bad Request 的常見原因）。
  // 只有在金鑰為空、或格式完全認不出來時，才退回使用者手動選的
  // 下拉選單值／已儲存金鑰的供應商別作為備援判斷依據。
  const detectedProvider = detectProviderFromKey(apiKey);
  const provider =
    detectedProvider || (options.provider === 'openai' ? 'openai' : 'gemini');
  const resolvedApiKey = apiKey || getStoredKey(provider) || '';
  const mode = options.mode || 'lossless';

  if (!resolvedApiKey) {
    emitError(
      `請先在上方輸入 ${PROVIDERS[provider].label} 的 API Key 才能使用 AI 文件處理功能。` +
        (provider === 'gemini' ? '（還沒有的話，可以到 Google AI Studio 免費申請，上方有教學）' : '')
    );
    return;
  }

  if (apiKey && !detectedProvider) {
    console.warn('[AiDocumentConverter] 無法從金鑰格式自動判斷供應商，改用下拉選單指定的值：', provider);
  }

  if (mode === 'custom' && !(options.customPrompt || '').trim()) {
    emitError('自訂提示詞模式下，請先輸入你想要 AI 執行的指令。');
    return;
  }

  busy = true;
  activeAbortController = new AbortController();
  registerMainThreadTask('ai-document', {
    onCancel: () => {
      if (activeAbortController) activeAbortController.abort();
    },
  });
  console.info('[AiDocumentConverter] 任務開始，供應商：', provider, detectedProvider ? '（依金鑰自動判斷）' : '（下拉選單指定）');

  try {
    await withTimeout(runPipeline(file, provider, resolvedApiKey, mode, options), TASK_TIMEOUT_MS, 'AI 文件處理');
  } catch (err) {
    if (err && err.name === 'AbortError') {
      emitError('已取消 AI 文件處理。');
    } else {
      console.error('[AiDocumentConverter] 處理失敗：', err);
      emitError(err && err.message ? err.message : 'AI 文件處理過程發生未知錯誤，請重新嘗試。');
    }
  } finally {
    busy = false;
    activeAbortController = null;
    clearMainThreadTask('ai-document', 'completed');
    console.info('[AiDocumentConverter] 任務結束，busy 旗標已重置。');
  }
}

/**
 * runPipeline(...)
 * -------------------------------------------------------------------------
 * 把 start() 原本內聯的流程抽成獨立函式，方便外層用 withTimeout() 包住
 * 整條流程（而不只是包住其中一段 await），確保無論卡在解析、呼叫 AI
 * API、還是 html2pdf 渲染的哪一個環節，都會被同一道逾時保險網接住。
 * -------------------------------------------------------------------------
 */
async function runPipeline(file, provider, apiKey, mode, options) {
  emitProgress(5, '正在解析 Word 文件內容...');
  const sourceHtml = await extractDocxHtml(file);

  if (!sourceHtml || sourceHtml.trim().length === 0) {
    throw new Error('無法從此 Word 文件解析出任何內容，檔案可能已損毀或為空白文件。');
  }

  emitProgress(30, `正在組合提示詞（${mode === 'lossless' ? '完整忠實轉寫' : mode === 'polish' ? 'AI 智慧整理' : '自訂提示詞'}）...`);
  const prompt =
    mode === 'custom'
      ? MODE_PROMPTS.custom(sourceHtml, options.customPrompt)
      : MODE_PROMPTS[mode](sourceHtml);

  emitProgress(45, `正在呼叫 ${PROVIDERS[provider].label} API 處理中，請稍候...`);
  const aiHtmlRaw = await callAiProvider(provider, apiKey, prompt, mode, activeAbortController.signal);
  const aiHtmlBody = stripLeadingTrailingBlankBlocks(aiHtmlRaw);

  // 檢查是否有 mammoth.js 無法轉換的 SmartArt 圖表。刻意不把這段警告
  // 一起丟給 AI 處理（尤其「完整忠實轉寫」模式會被要求逐字保留，AI
  // 可能誤把警告文字當成必須原樣保留的文件內容），而是等 AI 處理完
  // 之後才把警告跟「SmartArt 文字內容附錄」插在最終結果的前後。
  const smartArtCount = await countUnsupportedSmartArt(file);
  const smartArtDiagrams = smartArtCount > 0 ? await extractSmartArtTextContent(file) : [];
  const aiHtml =
    buildSmartArtWarningHtml(smartArtCount) + aiHtmlBody + buildSmartArtAppendixHtml(smartArtDiagrams);

  const baseName = file.name.replace(/\.docx?$/i, '');
  const outputFormat = options.outputFormat === 'html' ? 'html' : 'pdf';

  // ---- 輸出格式：HTML（純網頁檔，文字可選取/複製）----
  // 不需要經過 html2canvas 螢幕截圖，直接把 AI 回傳的 HTML 包成一份
  // 完整、可離線開啟的網頁檔案即可，速度也比產生 PDF 快很多。
  if (outputFormat === 'html') {
    emitProgress(90, '正在包裝 HTML 檔案...');
    const fullHtmlDoc = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<title>${baseName}</title>
<style>
  body { font-family: 'Noto Sans TC','PingFang TC','Microsoft JhengHei','Heiti TC',sans-serif; line-height: 1.8; color: #1e293b; max-width: 800px; margin: 40px auto; padding: 0 20px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  td, th { border: 1px solid #cbd5e1; padding: 6px 8px; }
  h1 { font-size: 22px; margin: 16px 0 8px; }
  h2 { font-size: 18px; margin: 14px 0 6px; }
  h3 { font-size: 16px; margin: 12px 0 6px; }
  p { margin: 6px 0; }
  img { max-width: 100%; }
</style>
</head>
<body>
${aiHtml}
</body>
</html>`;
    const htmlBlob = new Blob([fullHtmlDoc], { type: 'text/html' });

    emitProgress(98, '即將完成...');
    EventBus_instance.emit('converter:result', {
      tool: 'ai-document',
      blobUrl: URL.createObjectURL(htmlBlob),
      fileName: `${baseName}-AI處理.html`,
      fileSizeBytes: htmlBlob.size,
    });
    return;
  }

  // ---- 輸出格式：PDF（預設）----
  emitProgress(75, '正在讀取原始頁面設定...');
  const pageSetup = await extractDocxPageSetup(file);

  emitProgress(80, '正在產生 PDF...');
  const pdfBlob = await renderHtmlToPdfBlob(aiHtml, baseName, pageSetup);

  emitProgress(98, '即將完成...');
  const blobUrl = URL.createObjectURL(pdfBlob);

  EventBus_instance.emit('converter:result', {
    tool: 'ai-document',
    blobUrl,
    fileName: `${baseName}-AI處理.pdf`,
    fileSizeBytes: pdfBlob.size,
  });
}

EventBus_instance.on('converter:cancel', ({ tool }) => {
  if (tool !== 'ai-document') return;
  if (activeAbortController) {
    activeAbortController.abort();
  }
});
