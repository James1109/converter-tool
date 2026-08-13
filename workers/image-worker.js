/**
 * =============================================================================
 * workers/image-worker.js
 * =============================================================================
 * 【檔案定位】跟 ffmpeg-worker.js 不同，這支是「真正可運作」的實作，
 * 不是 mock。圖片格式轉換不需要依賴任何外部 Wasm 套件，瀏覽器原生的
 * Canvas API（在 Worker 環境裡是 OffscreenCanvas）就能完成解碼、
 * 重繪、重新編碼成指定格式的完整流程。
 *
 * 【訊息協定】沿用與 ffmpeg-worker.js 相同的 { type, payload } 格式：
 *   進：{ type:'start', payload:{ taskId, file, options:{format, quality} } }
 *   出：{ type:'progress', payload:{taskId, percent, label} }
 *       { type:'result', payload:{taskId, blob, fileName, fileSizeBytes} }
 *       { type:'error', payload:{taskId, message} }
 *
 * 這支 Worker 不處理 'cancel' 訊息：依照 WorkerLifecycle 的設計，
 * 圖片屬於「即用即丟」類型，取消時是直接呼叫 worker.terminate() 暴力
 * 終結（見 worker-lifecycle.js 的 cancelActiveWorker()），不需要
 * 像 FFmpeg 常駐 Worker 那樣走「優雅中斷」流程，因此這裡完全不需要
 * 監聽或處理 'cancel'。
 *
 * 【關於「進度」的誠實說明】
 * Canvas 的解碼/繪製/編碼對一般大小的圖片來說幾乎是瞬間完成，
 * 不像影片轉檔會有可觀察的漸進過程。這裡回報的進度是「真實的階段性
 * 進度」（每完成一個實際步驟才回報對應的百分比），不是像
 * ffmpeg-worker.js 的 mock 那樣用計時器假造出來的假進度——只是因為
 * 每個階段本身耗時很短，使用者可能感覺進度條是「用跳的」而不是平滑
 * 爬升，這是圖片轉檔這個任務本質上的特性，並非實作有誤。
 * =============================================================================
 */

function postToMain(type, payload = {}) {
  self.postMessage({ type, payload });
}

/**
 * resolveMimeType(format)
 * -------------------------------------------------------------------------
 * 把使用者選擇的格式字串（'jpeg' | 'png' | 'webp'）轉成
 * canvas.convertToBlob() 需要的正確 MIME type 字串。
 * -------------------------------------------------------------------------
 */
function resolveMimeType(format) {
  const map = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };
  return map[format] || 'image/jpeg';
}

/**
 * buildOutputFileName(originalName, format)
 * -------------------------------------------------------------------------
 * 與 ffmpeg-worker.js 的同名函式邏輯一致：把原始檔名的副檔名換成
 * 使用者選擇的輸出格式，並加上 -converted 後綴避免跟原始檔名混淆。
 * -------------------------------------------------------------------------
 */
function buildOutputFileName(originalName, format) {
  const dotIndex = originalName.lastIndexOf('.');
  const baseName = dotIndex === -1 ? originalName : originalName.slice(0, dotIndex);
  return `${baseName}-converted.${format || 'jpeg'}`;
}

/**
 * runImageConversion(taskId, file, options)
 * -------------------------------------------------------------------------
 * 真正的轉檔流程，分成四個可觀察的階段，每個階段完成後回報一次進度：
 *   10%  → 開始解碼原始圖片檔案
 *   40%  → 解碼完成，取得圖片尺寸，準備建立畫布
 *   70%  → 已將圖片繪製到畫布上，準備編碼輸出
 *   100% → 編碼完成，取得最終 Blob
 * -------------------------------------------------------------------------
 */
async function runImageConversion(taskId, file, options) {
  postToMain('progress', { taskId, percent: 10, label: '正在解碼圖片...' });

  // createImageBitmap 是瀏覽器原生 API，在 Worker 環境下同樣可用，
  // 比起傳統的 <img> 標籤讀取方式更適合 Worker（因為 Worker 沒有
  // DOM，無法建立 <img> 元素），且解碼是交給瀏覽器底層（通常有
  //硬體加速），效能比純 JS 解析圖片格式好上非常多。
  const imageBitmap = await createImageBitmap(file);

  postToMain('progress', {
    taskId,
    percent: 40,
    label: `圖片解碼完成（${imageBitmap.width}×${imageBitmap.height}）`,
  });

  // OffscreenCanvas 是 Canvas API 的 Worker 相容版本，用法幾乎與
  // 主執行緒的 <canvas> 一致，差別只在建構子需要顯式傳入寬高，
  // 且沒有對應的 DOM 元素（因為 Worker 裡沒有 DOM）。
  const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('無法取得 2D 繪圖上下文，此瀏覽器可能不支援 OffscreenCanvas。');
  }

  // 若輸出格式是 JPEG（不支援透明背景），先鋪一層白色底色，避免原本
  // 帶有透明通道的 PNG／WebP 圖片轉成 JPEG 後，透明區域變成預設的
  // 黑色（這是多數瀏覽器在編碼 JPEG 時對透明像素的預設處理方式，
  // 明確鋪白底可以得到更符合使用者預期的視覺結果）。
  if (options.format === 'jpeg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.drawImage(imageBitmap, 0, 0);
  imageBitmap.close(); // 明確釋放 ImageBitmap 佔用的記憶體，不等垃圾回收自動處理

  postToMain('progress', { taskId, percent: 70, label: '正在編碼輸出格式...' });

  const mimeType = resolveMimeType(options.format);
  // convertToBlob 的 quality 參數僅對 'image/jpeg' 與 'image/webp' 生效
  // （PNG 是無損格式，quality 參數會被瀏覽器直接忽略），這裡統一傳入
  // 沒有壞處，程式碼也不需要為了 PNG 額外分支處理。
  const quality = typeof options.quality === 'number' ? options.quality / 100 : 0.8;

  const blob = await canvas.convertToBlob({ type: mimeType, quality });

  postToMain('progress', { taskId, percent: 100, label: '轉檔完成' });

  postToMain('result', {
    taskId,
    blob,
    fileName: buildOutputFileName(file.name, options.format),
    fileSizeBytes: blob.size,
  });
}

self.onmessage = async (event) => {
  const { type, payload } = event.data || {};

  if (type === 'start') {
    const { taskId, file, options } = payload;
    try {
      await runImageConversion(taskId, file, options || {});
    } catch (err) {
      postToMain('error', {
        taskId,
        message: err && err.message ? err.message : '圖片轉檔過程發生未預期的錯誤。',
      });
    }
    return;
  }

  // 'cancel' 訊息不需要處理，詳見檔案頂端說明。
  console.warn('[image-worker] 收到未處理的訊息類型：', type);
};
