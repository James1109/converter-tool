/**
 * =============================================================================
 * converters/VideoConverter.js
 * =============================================================================
 * 【架構更新：改為呼叫共用的 ffmpeg-engine.js】
 *
 * 先前的版本自己管理一份獨立的 FFmpeg 實例。新增音訊轉檔功能後，
 * 把「引擎生命週期管理」抽到 ffmpeg-engine.js 共用模組（詳見該檔案
 * 頂端說明），影音與音訊轉檔共用同一個 FFmpeg 實例、同一份「忙碌中」
 * 狀態，避免使用者同時觸發兩種任務時互相搶用 Wasm 實例。
 *
 * 本檔案現在只保留「影音轉檔特有」的邏輯：
 *   - 輸出格式對應的檔名/MIME type
 *   - GIF 的兩階段調色盤最佳化命令
 *   - 其餘格式（mp4/webm）的單階段命令
 * 其餘（Worker/主執行緒例外說明、常駐策略、取消機制）都已經下沉到
 * ffmpeg-engine.js，此處不再重複。
 * =============================================================================
 */

import { EventBus_instance } from '../event-bus.js';
import { runFfmpegJob, isFfmpegEngineBusy, cancelFfmpegJob } from '../ffmpeg-engine.js';

function generateTaskId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `video-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildOutputFileName(originalName, format) {
  const dotIndex = originalName.lastIndexOf('.');
  const baseName = dotIndex === -1 ? originalName : originalName.slice(0, dotIndex);
  return `${baseName}-converted.${format || 'mp4'}`;
}

function resolveMimeType(format) {
  const map = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif' };
  return map[format] || 'video/mp4';
}

/**
 * buildSteps(inputName, outputName, format)
 * -------------------------------------------------------------------------
 * 依格式組出要交給 ffmpeg-engine.js 依序執行的命令陣列。
 * GIF 用兩階段（palettegen + paletteuse）取得較佳色彩品質，詳細原理
 * 說明保留在這裡（屬於影音轉檔的專業知識，不屬於共用引擎的職責）：
 *
 *   第一階段（palettegen）：先完整分析一次畫面內容，產生一張「最適合
 *   這支影片顏色分布」的 256 色調色盤圖片。
 *   第二階段（paletteuse）：套用剛剛產生的專屬調色盤，重新編碼成最終
 *   的 GIF，色彩準確度比單階段轉換好上不少。
 * -------------------------------------------------------------------------
 */
function buildSteps(inputName, outputName, format) {
  if (format === 'gif') {
    const paletteName = 'palette.png';
    const filterBase = 'fps=10,scale=480:-1:flags=lanczos';
    return [
      {
        args: ['-i', inputName, '-vf', `${filterBase},palettegen`, paletteName],
        progressPercent: 55,
        progressLabel: '正在分析畫面產生最佳調色盤...',
        // 供 runFfmpegJob 清理時一併刪除這個中繼檔案
        __paletteName: paletteName,
      },
      {
        args: ['-i', inputName, '-i', paletteName, '-lavfi', `${filterBase} [x]; [x][1:v] paletteuse`, outputName],
        progressPercent: 75,
        progressLabel: '正在套用調色盤編碼...',
      },
    ];
  }

  return [{ args: ['-i', inputName, outputName], progressPercent: 50, progressLabel: '正在轉碼中...' }];
}

export function isBusy() {
  return isFfmpegEngineBusy();
}

export async function start(file, options = {}) {
  const taskId = generateTaskId();
  const format = options.format || 'mp4';
  const inputExt = file.name.slice(file.name.lastIndexOf('.') + 1) || 'mp4';
  const inputName = `input.${inputExt}`;
  const outputName = `output.${format}`;

  const steps = buildSteps(inputName, outputName, format);
  // GIF 兩階段流程會多產生一個 palette.png 中繼檔案，需要額外清理，
  // 從 steps 裡把標記出來的檔名抽出來交給 runFfmpegJob。
  const extraCleanupNames = steps.filter((s) => s.__paletteName).map((s) => s.__paletteName);

  try {
    const { blob, fileSizeBytes } = await runFfmpegJob({
      tool: 'video',
      taskId,
      file,
      inputName,
      outputName,
      buildSteps: () => steps,
      mimeType: resolveMimeType(format),
      extraCleanupNames,
    });

    const blobUrl = URL.createObjectURL(blob);
    EventBus_instance.emit('converter:progress-raw', { tool: 'video', percent: 100, label: '轉檔完成' });
    EventBus_instance.emit('converter:result', {
      tool: 'video',
      blobUrl,
      fileName: buildOutputFileName(file.name, format),
      fileSizeBytes,
    });
  } catch (err) {
    console.error('[VideoConverter] 影音轉檔失敗：', err);
    EventBus_instance.emit('converter:error', {
      tool: 'video',
      message: err && err.message ? err.message : '影音轉檔過程發生未預期的錯誤。',
    });
  }
}

// 取消邏輯下沉到共用引擎，這裡只需要把 'converter:cancel' 事件轉呼叫過去。
EventBus_instance.on('converter:cancel', ({ tool }) => {
  if (tool !== 'video') return;
  cancelFfmpegJob('video');
});
