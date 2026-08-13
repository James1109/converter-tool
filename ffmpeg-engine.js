/**
 * =============================================================================
 * ffmpeg-engine.js
 * =============================================================================
 * 【模組定位】
 * 集中管理「唯一一份」@ffmpeg/ffmpeg 實例，供 VideoConverter.js 與
 * AudioConverter.js 共用。抽出這個共用模組的理由：
 *
 *   FFmpeg.wasm 的底層是單一個 Wasm 模組實例，同一時間只能執行一個
 *   轉檔任務（不像瀏覽器原生 Canvas 那樣可以輕易平行處理多個獨立
 *   工作）。如果影音轉檔跟音訊轉檔各自維護一份獨立的 FFmpeg 實例：
 *     1. 使用者若前後轉了一個影片、又轉一個音訊，會重複付出兩次
 *        「下載+初始化引擎」的成本，明明是同一套引擎卻要暖機兩次。
 *     2. 更嚴重的是：如果沒有共用「目前忙碌中」狀態，使用者有可能
 *        在影片還在轉檔時，又跑去音訊分頁點了開始轉檔，兩個獨立的
 *        FFmpeg 實例同時嘗試運算，容易造成瀏覽器分頁記憶體/效能
 *        雙倍消耗，甚至互相干擾。
 *
 *   因此不管是「影片轉檔」還是「音訊轉檔」，實際上都是在呼叫這裡
 *   同一份共用引擎，`isFfmpegEngineBusy()` 回報的是「引擎」本身的忙碌
 *   狀態，而不是分別的「video 忙碌」「audio 忙碌」，這樣才能正確防止
 *   兩種任務同時搶用同一個 Wasm 實例。
 *
 * 【與 VideoConverter.js / AudioConverter.js 的分工】
 * 這裡只負責「引擎生命週期」與「執行一段 FFmpeg 命令序列」這種通用
 * 邏輯；「輸出格式該對應什麼 exec 參數」「檔名怎麼組」這種轉檔類型
 * 專屬的細節，留給呼叫端（各自的 Converter）決定，透過 buildSteps
 * 這個回呼函式傳進來，維持職責分離。
 * =============================================================================
 */

import { EventBus_instance } from './event-bus.js';

const FFMPEG_LIB_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js';
const FFMPEG_CORE_PATH = 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js';
const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 分鐘閒置才真正銷毀

let createFFmpegFn = null;
let ffmpegInstance = null;
let isLoaded = false;
let idleTimerId = null;

/**
 * currentJob：記錄「目前是哪個 tool、哪個 taskId 在使用引擎」，
 * 是整個共用機制的核心——isFfmpegEngineBusy() 依此判斷引擎是否可用，
 * cancelFfmpegJob(tool) 依此判斷「你要取消的任務是不是真的正在跑」。
 */
let currentJob = null; // { tool, taskId } | null

function loadUmdScriptViaTag(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`無法載入外部函式庫：${url}`));
    document.head.appendChild(script);
  });
}

function clearIdleTimer() {
  if (idleTimerId !== null) {
    clearTimeout(idleTimerId);
    idleTimerId = null;
  }
}

function scheduleIdleDestroy() {
  clearIdleTimer();
  idleTimerId = setTimeout(() => {
    if (ffmpegInstance) {
      try {
        ffmpegInstance.exit();
      } catch (err) {
        console.warn('[ffmpeg-engine] 閒置銷毀時呼叫 exit() 發生問題：', err);
      }
    }
    ffmpegInstance = null;
    isLoaded = false;
  }, IDLE_TIMEOUT_MS);
}

async function ensureFfmpegLoaded(tool) {
  if (isLoaded) {
    clearIdleTimer();
    return ffmpegInstance;
  }

  if (!createFFmpegFn) {
    await loadUmdScriptViaTag(FFMPEG_LIB_URL);
    createFFmpegFn = window.FFmpeg.createFFmpeg;
  }

  ffmpegInstance = createFFmpegFn({
    log: true,
    corePath: FFMPEG_CORE_PATH,
    logger: ({ message }) => console.debug('[ffmpeg-engine][core log]', message),
  });

  ffmpegInstance.setProgress(({ ratio }) => {
    if (!currentJob) return;
    const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    EventBus_instance.emit('converter:progress-raw', {
      tool: currentJob.tool,
      percent,
      label: '正在轉碼中...',
    });
  });

  EventBus_instance.emit('converter:progress-raw', { tool, percent: 20, label: '正在初始化轉檔引擎...' });

  const LOAD_TIMEOUT_MS = 60 * 1000;
  await Promise.race([
    ffmpegInstance.load(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`轉碼引擎初始化逾時（超過 ${LOAD_TIMEOUT_MS / 1000} 秒未完成）。`)),
        LOAD_TIMEOUT_MS
      )
    ),
  ]);

  isLoaded = true;
  return ffmpegInstance;
}

async function fileToUint8Array(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * isFfmpegEngineBusy()
 * -------------------------------------------------------------------------
 * 供 VideoConverter.isBusy() 與 AudioConverter.isBusy() 直接轉呼叫，
 * 兩者回報的其實是同一份共用狀態。
 * -------------------------------------------------------------------------
 */
export function isFfmpegEngineBusy() {
  return currentJob !== null;
}

/**
 * runFfmpegJob({ tool, taskId, file, inputName, outputName, buildSteps, mimeType })
 * -------------------------------------------------------------------------
 * 執行一段完整的 FFmpeg 轉檔流程：載入引擎（若尚未載入）→ 寫入輸入
 * 檔案 → 依序執行 buildSteps() 產生的每一段命令（支援像 GIF 那樣需要
 * 兩階段 palettegen/paletteuse 的情境）→ 讀出結果 → 清理暫存檔案。
 *
 * buildSteps(inputName, outputName) 由呼叫端提供，回傳一個陣列，
 * 每個元素是 { args: string[], progressLabel } —— args 會被展開傳給
 * ffmpeg.run(...args)。
 *
 * 回傳值：{ blob, fileSizeBytes }，呼叫端自行組成 fileName 並
 * emit 'converter:result'。
 * -------------------------------------------------------------------------
 */
export async function runFfmpegJob({ tool, taskId, file, inputName, outputName, buildSteps, mimeType, extraCleanupNames = [] }) {
  if (currentJob !== null) {
    throw new Error('轉檔引擎目前正被其他任務使用中，請稍候再試。');
  }
  currentJob = { tool, taskId };

  try {
    const ffmpeg = await ensureFfmpegLoaded(tool);

    EventBus_instance.emit('converter:progress-raw', { tool, percent: 40, label: '正在寫入暫存檔案...' });
    ffmpeg.FS('writeFile', inputName, await fileToUint8Array(file));

    const steps = buildSteps(inputName, outputName);
    for (const step of steps) {
      EventBus_instance.emit('converter:progress-raw', {
        tool,
        percent: step.progressPercent ?? 50,
        label: step.progressLabel || '正在轉碼中...',
      });
      await ffmpeg.run(...step.args);
    }

    EventBus_instance.emit('converter:progress-raw', { tool, percent: 95, label: '正在讀取轉檔結果...' });
    const data = ffmpeg.FS('readFile', outputName);

    const cleanupNames = [inputName, outputName, ...extraCleanupNames];
    for (const name of cleanupNames) {
      try {
        ffmpeg.FS('unlink', name);
      } catch (err) {
        console.warn(`[ffmpeg-engine] 清理暫存檔案 ${name} 時發生問題：`, err);
      }
    }

    const blob = new Blob([data.buffer], { type: mimeType });

    scheduleIdleDestroy();
    return { blob, fileSizeBytes: blob.size };
  } catch (err) {
    // 發生錯誤時不確定 FFmpeg 內部狀態是否還可信賴，保守起見直接銷毀，
    // 下次任務重新初始化。
    clearIdleTimer();
    if (ffmpegInstance) {
      try {
        ffmpegInstance.exit();
      } catch (exitErr) {
        console.warn('[ffmpeg-engine] 錯誤後清理 exit() 發生問題：', exitErr);
      }
    }
    ffmpegInstance = null;
    isLoaded = false;
    throw err;
  } finally {
    currentJob = null;
  }
}

/**
 * cancelFfmpegJob(tool)
 * -------------------------------------------------------------------------
 * 只有當「目前正在跑的任務確實屬於這個 tool」時才會真的執行取消，
 * 避免使用者在影片分頁按下取消，卻不小心打斷了音訊分頁的任務（雖然
 * 兩者共用同一個引擎、理論上不會同時有兩個任務，這裡仍加上比對
 * 作為防禦）。回傳值代表「這次呼叫是否真的觸發了取消」，呼叫端可以
 * 用這個結果決定要不要 emit 'converter:cancelled'。
 * -------------------------------------------------------------------------
 */
export function cancelFfmpegJob(tool) {
  if (!currentJob || currentJob.tool !== tool) return false;

  const cancelledTaskId = currentJob.taskId;
  currentJob = null;

  clearIdleTimer();
  if (ffmpegInstance) {
    try {
      ffmpegInstance.exit();
    } catch (err) {
      console.warn('[ffmpeg-engine] 取消時呼叫 exit() 發生問題：', err);
    }
  }
  ffmpegInstance = null;
  isLoaded = false;

  EventBus_instance.emit('converter:cancelled', { tool, taskId: cancelledTaskId });
  return true;
}
