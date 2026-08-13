/**
 * =============================================================================
 * converters/PdfConverter.js
 * =============================================================================
 * 【重要架構異動說明，請詳讀】
 * 'word-to-pdf' 方向原本透過 createEphemeralWorker() 交給
 * workers/pdf-worker.js（mammoth.js + pdf-lib 手動排版）在獨立 Worker
 * 執行緒中處理。實測發現：只要原始文件裡出現英文字母組合剛好命中
 * 內嵌字型的 GSUB 連字規則（例如 "Firebase"、"office" 裡的 "fi"），
 * pdf-lib 底層的 fontkit 會把這兩個字母合併成一個連字字形，但
 * pdf-worker.js 手刻的換行/字寬計算邏輯是按「一個字元＝一份寬度」
 * 在算的，兩者對不起來，就會出現「數字跟文字疊在一起」「firebase
 * 被拆成 fi + rebase 甚至變成亂碼」這類排版錯誤。這是 pdf-lib/
 * fontkit 連字替換與手刻排版邏輯衝突的已知問題類別，不是單一行
 * 程式碼可以簡單修掉的臭蟲。
 *
 * 因此 'word-to-pdf' 方向改成跟 AiDocumentConverter 共用同一套
 * html-to-pdf-renderer.js（html2canvas 螢幕截圖式渲染）：文字排版
 * 交給瀏覽器自己處理，我們只是把畫面截圖存成 PDF，從根本上避開
 *「自己算寬度算錯」這個問題類別。代價是輸出的 PDF 文字不可反白
 * 選取/複製（截圖本質如此），這點會在 UI 上跟使用者說明清楚。
 *
 * workers/pdf-worker.js 檔案本身保留在專案中但不再被呼叫（deprecated），
 * 之後如果要徹底移除記得一併清掉 worker 檔案本身。
 *
 * 'pdf-to-image' 方向維持原本設計，一樣在主執行緒執行（pdf.js 的對外
 * API 入口 pdfjsLib.getDocument() 會存取 `document` 這個瀏覽器全域
 * 物件，Worker 執行緒內沒有這個物件會直接拋錯，這是函式庫本身的
 * 設計限制）。
 * =============================================================================
 */

import { EventBus_instance } from '../event-bus.js';
import { registerMainThreadTask, clearMainThreadTask } from '../worker-lifecycle.js';
import { extractDocxHtml } from '../mammoth-extract.js';
import { renderHtmlToPdfBlob } from '../html-to-pdf-renderer.js';
import { extractDocxPageSetup } from '../docx-page-setup.js';
import { countUnsupportedSmartArt, buildSmartArtWarningHtml } from '../docx-content-audit.js';
import { renderAllSmartArtToHtml } from '../docx-smartart-render.js';

const PDFJS_LIB_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs';
const PDFJS_CMAPS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/cmaps/';
const PDFJS_STANDARD_FONTS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/standard_fonts/';

// 'word-to-pdf' 現在也是主執行緒路徑了，跟 'pdf-to-image' 共用同一個
// 忙碌旗標即可——'document' 這個 tool 本來就只可能同時執行其中一個
// 方向，不會有兩個方向搶著跑的情境。
let isMainThreadTaskBusy = false;
let cachedPdfjsLib = null;

function buildOutputFileName(originalName, suffix, ext) {
  const dotIndex = originalName.lastIndexOf('.');
  const baseName = dotIndex === -1 ? originalName : originalName.slice(0, dotIndex);
  return `${baseName}-${suffix}.${ext}`;
}

/**
 * isBusy()
 * -------------------------------------------------------------------------
 * 供 ConverterOrchestrator 在 handleStart() 裡一併檢查。
 * -------------------------------------------------------------------------
 */
export function isBusy() {
  return isMainThreadTaskBusy;
}

/**
 * start(file, options)
 * -------------------------------------------------------------------------
 * 對外唯一入口，依 options.direction 分流。
 * -------------------------------------------------------------------------
 */
export async function start(file, options = {}) {
  if (options.direction === 'pdf-to-image') {
    return runPdfToImageOnMainThread(file, options);
  }
  return runWordToPdfOnMainThread(file, options);
}

// =========================================================================
// 'word-to-pdf' 方向：mammoth.js 解析 + html-to-pdf-renderer 共用渲染器
// =========================================================================

async function runWordToPdfOnMainThread(file, options) {
  if (isMainThreadTaskBusy) {
    console.warn('[PdfConverter] 已有一個文件轉檔任務在執行中，忽略本次重複呼叫。');
    return;
  }
  isMainThreadTaskBusy = true;
  registerMainThreadTask('document', { onCancel: null }); // pdf.js/html2canvas 都沒有乾淨的中途取消 API，見檔頭說明

  try {
    EventBus_instance.emit('converter:progress-raw', {
      tool: 'document',
      percent: 10,
      label: '正在解析 Word 文件內容...',
    });

    const sourceHtml = await extractDocxHtml(file);
    if (!sourceHtml || sourceHtml.trim().length === 0) {
      throw new Error('無法從此 Word 文件解析出任何內容，檔案可能已損毀或為空白文件。');
    }

    // 檢查是否有 mammoth.js 無法轉換的 SmartArt 圖表，有的話在內容最前面
    // 插入提示，並嘗試用 docx-smartart-render.js 把 Word 內部存的
    // 「SmartArt 備援渲染快照」還原成 SVG 圖表（見該檔案檔頭說明，這
    // 不是重新實作排版演算法，是讀取 Word 自己存好的算圖結果）；還原
    // 失敗或該文件版本沒有這份快照時，renderAllSmartArtToHtml 會回傳
    // 空字串，畫面上只會看到警告，不會出現錯誤。
    const smartArtCount = await countUnsupportedSmartArt(file);
    const smartArtHtml = smartArtCount > 0 ? await renderAllSmartArtToHtml(file) : '';
    const sourceHtmlWithWarning = buildSmartArtWarningHtml(smartArtCount) + sourceHtml + smartArtHtml;

    EventBus_instance.emit('converter:progress-raw', {
      tool: 'document',
      percent: 30,
      label: '正在讀取原始頁面設定...',
    });

    // 讀取原始 .docx 實際使用的頁面尺寸/邊界/字級，讓輸出 PDF 的分頁
    // 位置盡量貼近 Word 原本的樣子，而不是套用我們憑感覺猜的固定值。
    const pageSetup = await extractDocxPageSetup(file);

    EventBus_instance.emit('converter:progress-raw', {
      tool: 'document',
      percent: 50,
      label: '正在產生 PDF...',
    });

    const baseName = file.name.replace(/\.docx?$/i, '');
    const pdfBlob = await renderHtmlToPdfBlob(sourceHtmlWithWarning, baseName, pageSetup);

    EventBus_instance.emit('converter:progress-raw', { tool: 'document', percent: 100, label: '轉檔完成' });

    EventBus_instance.emit('converter:result', {
      tool: 'document',
      blobUrl: URL.createObjectURL(pdfBlob),
      fileName: buildOutputFileName(file.name, 'converted', 'pdf'),
      fileSizeBytes: pdfBlob.size,
    });
  } catch (err) {
    console.error('[PdfConverter] Word 轉 PDF 失敗：', err);
    EventBus_instance.emit('converter:error', {
      tool: 'document',
      message: err && err.message ? err.message : 'Word 轉 PDF 過程發生未預期的錯誤。',
    });
  } finally {
    isMainThreadTaskBusy = false;
    clearMainThreadTask('document', 'completed');
  }
}

// =========================================================================
// 'pdf-to-image' 方向：主執行緒路徑（pdf.js 環境限制所致的例外）
// =========================================================================

/**
 * runPdfToImageOnMainThread(file, options)
 * -------------------------------------------------------------------------
 * 完整流程對照 workers/pdf-worker.js 先前 mock/實作階段的邏輯，差異
 * 只在於「在哪個執行緒跑」，訊息協定不需要 postMessage 往返，直接呼叫
 * EventBus_instance.emit() 廣播進度/結果/錯誤即可。
 * -------------------------------------------------------------------------
 */
async function runPdfToImageOnMainThread(file, options) {
  if (isMainThreadTaskBusy) {
    // 理論上 ConverterOrchestrator 呼叫前就會先檢查 isBusy()，這裡是
    // 最後一道防線，避免任何遺漏的呼叫路徑造成同時執行兩個任務。
    console.warn('[PdfConverter] 已有一個 PDF 轉圖片任務在執行中，忽略本次重複呼叫。');
    return;
  }
  isMainThreadTaskBusy = true;

  try {
    EventBus_instance.emit('converter:progress-raw', {
      tool: 'document',
      percent: 10,
      label: '正在載入 PDF 解析引擎...',
    });

    if (!cachedPdfjsLib) {
      cachedPdfjsLib = await import(/* webpackIgnore: true */ PDFJS_LIB_URL);

      // 跟 Worker 版本一樣的道理：workerSrc 若直接設成跨來源絕對網址，
      // pdf.js 內部建立它自己管理的第二層 Worker 時一樣會撞上瀏覽器
      // 對跨來源 Worker 建構的限制，因此同樣手動 fetch 後轉成同源
      // Blob URL。
      const workerScriptResponse = await fetch(PDFJS_WORKER_URL);
      const workerScriptBlob = await workerScriptResponse.blob();
      cachedPdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerScriptBlob);
    }

    EventBus_instance.emit('converter:progress-raw', {
      tool: 'document',
      percent: 25,
      label: '正在解析 PDF 文件結構...',
    });

    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = cachedPdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: PDFJS_CMAPS_URL,
      cMapPacked: true,
      standardFontDataUrl: PDFJS_STANDARD_FONTS_URL,
    });
    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;

    // -------------------------------------------------------------------
    // 【多頁輸出】依序渲染每一頁，全部完成後才一次性 emit 單一個
    // 'converter:result'（detail.files 是一個陣列），而不是每渲染完
    // 一頁就各自 emit 一次 'converter:result'。
    //
    // 為什麼要這樣做：ProgressGuard 把收到 'converter:result' 視為
    // 「這個 tool 的任務已經完成」的訊號，會把進度瞬間拉到 100% 再
    // 歸零重置狀態（見 progress-guard.js 的 handleTaskCompleted()）。
    // 如果每一頁都各自 emit 一次，使用者會看到進度條「100% → 突然
    // 歸零 → 重新爬升」這樣的畫面在每一頁之間重複跳動，體驗很差；
    // 改成全部頁面都渲染完才一次回報，進度條才能連續平滑地從頭跑到
    // 完成一次就好。
    // -------------------------------------------------------------------
    const renderedFiles = [];
    // 45~90 這個區間原本是「渲染單頁」的進度範圍，多頁時依頁數平均切分。
    const PROGRESS_RANGE_START = 45;
    const PROGRESS_RANGE_END = 90;
    const progressPerPage = (PROGRESS_RANGE_END - PROGRESS_RANGE_START) / numPages;

    for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
      const pageStartPercent = Math.round(PROGRESS_RANGE_START + progressPerPage * (pageNumber - 1));
      EventBus_instance.emit('converter:progress-raw', {
        tool: 'document',
        percent: pageStartPercent,
        label: `正在渲染第 ${pageNumber}／${numPages} 頁...`,
      });

      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });

      // 現在身處主執行緒，有 document 物件可用，這裡沿用一般網頁常見的
      // <canvas> 元素做法（跟 OffscreenCanvas 效果相同，選用哪一種都
      // 可以，這裡選 document.createElement 讓程式碼讀起來更直覺）。
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error(`無法將第 ${pageNumber} 頁的渲染結果輸出為圖片。`));
        }, 'image/png');
      });

      renderedFiles.push({
        blobUrl: URL.createObjectURL(blob),
        fileName: buildOutputFileName(file.name, `page${pageNumber}`, 'png'),
        fileSizeBytes: blob.size,
      });
    }

    EventBus_instance.emit('converter:progress-raw', { tool: 'document', percent: 100, label: '轉檔完成' });

    EventBus_instance.emit('converter:result', {
      tool: 'document',
      files: renderedFiles,
    });
  } catch (err) {
    console.error('[PdfConverter] PDF 轉圖片失敗：', err);
    EventBus_instance.emit('converter:error', {
      tool: 'document',
      message: err && err.message ? err.message : 'PDF 轉圖片過程發生未預期的錯誤。',
    });
  } finally {
    isMainThreadTaskBusy = false;
  }
}
