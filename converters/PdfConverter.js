/**
 * =============================================================================
 * converters/PdfConverter.js
 * =============================================================================
 * 現在只剩 'pdf-to-image'（PDF 逐頁轉圖片）這一條路徑。原本這裡還有
 * 一條 'word-to-pdf' 路徑（mammoth.js + html2canvas 螢幕截圖渲染），
 * 但既然「精準轉檔」分頁（converters/GithubActionsConverter.js，走
 * 真正的 LibreOffice 排版引擎）在排版精確度、字型處理、SmartArt 支援
 * 上全面勝出，維護兩條 Word→PDF 路徑不再有意義，已經整個移除，UI 上
 * 也拿掉了對應的格式選項。
 *
 * 'pdf-to-image' 維持在主執行緒執行（pdf.js 的對外 API 入口
 * pdfjsLib.getDocument() 會存取 `document` 這個瀏覽器全域物件，Worker
 * 執行緒內沒有這個物件會直接拋錯，這是函式庫本身的設計限制）。
 * =============================================================================
 */

import { EventBus_instance } from '../event-bus.js';

const PDFJS_LIB_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs';
const PDFJS_CMAPS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/cmaps/';
const PDFJS_STANDARD_FONTS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/standard_fonts/';

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
 * 對外唯一入口。目前只有一種行為（PDF 轉圖片），保留 options 參數是
 * 為了跟其他 Converter 維持一致的呼叫介面，不代表未來一定會再擴充
 * 方向選項。
 * -------------------------------------------------------------------------
 */
export async function start(file, options = {}) {
  return runPdfToImageOnMainThread(file, options);
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
