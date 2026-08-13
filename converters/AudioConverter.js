/**
 * =============================================================================
 * converters/AudioConverter.js
 * =============================================================================
 * 音訊格式互轉（MP3/WAV/OGG），架構與 VideoConverter.js 完全一致：
 * 兩者都是 ffmpeg-engine.js 這個共用引擎的薄包裝層，差異只在於各自
 * 「輸出格式對應什麼命令/MIME type」這種轉檔類型專屬的細節。
 *
 * 這三種格式（mp3/wav/ogg）都已經確認包含在我們使用的 FFmpeg 核心
 * 建置版本裡（先前 Console 的核心編譯資訊有出現
 * --enable-libmp3lame --enable-libvorbis，wav 是無壓縮 PCM，
 * 所有 FFmpeg 建置都原生支援），單階段命令即可，不需要像 GIF 那樣的
 * 兩階段最佳化流程。
 * =============================================================================
 */

import { EventBus_instance } from '../event-bus.js';
import { runFfmpegJob, isFfmpegEngineBusy, cancelFfmpegJob } from '../ffmpeg-engine.js';

function generateTaskId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `audio-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildOutputFileName(originalName, format) {
  const dotIndex = originalName.lastIndexOf('.');
  const baseName = dotIndex === -1 ? originalName : originalName.slice(0, dotIndex);
  return `${baseName}-converted.${format || 'mp3'}`;
}

function resolveMimeType(format) {
  const map = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };
  return map[format] || 'audio/mpeg';
}

/**
 * buildExecArgs(inputName, outputName, format, options)
 * -------------------------------------------------------------------------
 * 音訊轉檔額外支援「位元率調整」選項（options.bitrate，例如 '128k'、
 * '192k'、'320k'），只對有損格式（mp3/ogg）有意義；wav 是無損 PCM，
 * 沒有位元率這個概念，這裡會直接忽略該選項。
 *
 * `-vn`（no video）：不管輸入的是純音訊檔案還是影片檔案都一律加上這個
 * 參數。對純音訊輸入來說這個參數是無意義但無害的；對影片輸入來說，
 * 這個參數會讓 FFmpeg 忽略影片畫面軌道、只處理音訊軌道，正是「影片
 * 轉音訊」（擷取音軌）這個功能需要的關鍵參數。統一加上可以讓同一段
 * 命令組出邏輯同時支援「音訊轉音訊」與「影片轉音訊」兩種情境，不需要
 * 額外判斷輸入檔案類型。
 * -------------------------------------------------------------------------
 */
function buildExecArgs(inputName, outputName, format, options) {
  const args = ['-i', inputName, '-vn'];

  if (format !== 'wav' && options.bitrate) {
    args.push('-b:a', options.bitrate);
  }

  args.push(outputName);
  return args;
}

export function isBusy() {
  return isFfmpegEngineBusy();
}

export async function start(file, options = {}) {
  const taskId = generateTaskId();
  const format = options.format || 'mp3';
  const inputExt = file.name.slice(file.name.lastIndexOf('.') + 1) || 'mp3';
  const inputName = `input.${inputExt}`;
  const outputName = `output.${format}`;

  try {
    const { blob, fileSizeBytes } = await runFfmpegJob({
      tool: 'audio',
      taskId,
      file,
      inputName,
      outputName,
      buildSteps: () => [
        {
          args: buildExecArgs(inputName, outputName, format, options),
          progressPercent: 50,
          progressLabel: '正在轉碼中...',
        },
      ],
      mimeType: resolveMimeType(format),
    });

    const blobUrl = URL.createObjectURL(blob);
    EventBus_instance.emit('converter:progress-raw', { tool: 'audio', percent: 100, label: '轉檔完成' });
    EventBus_instance.emit('converter:result', {
      tool: 'audio',
      blobUrl,
      fileName: buildOutputFileName(file.name, format),
      fileSizeBytes,
    });
  } catch (err) {
    console.error('[AudioConverter] 音訊轉檔失敗：', err);
    EventBus_instance.emit('converter:error', {
      tool: 'audio',
      message: err && err.message ? err.message : '音訊轉檔過程發生未預期的錯誤。',
    });
  }
}

EventBus_instance.on('converter:cancel', ({ tool }) => {
  if (tool !== 'audio') return;
  cancelFfmpegJob('audio');
});
