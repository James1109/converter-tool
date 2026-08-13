/**
 * =============================================================================
 * converters/ImageConverter.js
 * =============================================================================
 * 架構與 VideoConverter.js 相同的三段式職責（發起任務 / 轉發訊息 /
 * 收尾銷毀），差異在於圖片屬於「即用即丟」策略：任務結束（無論成功或
 * 失敗）就立刻呼叫 destroyEphemeralWorker()，不像 FFmpeg 常駐 Worker
 * 需要 3 分鐘閒置倒數，也不需要處理「cancelled 確認」這個中間狀態
 * ——取消時 WorkerLifecycle 會直接對即用即丟 Worker 呼叫 terminate()，
 * ImageConverter 本身完全不需要參與取消流程。
 * =============================================================================
 */

import { EventBus_instance } from '../event-bus.js';
import { createEphemeralWorker, destroyEphemeralWorker } from '../worker-lifecycle.js';

let currentTaskId = null;

function generateTaskId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `image-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * start(file, options)
 * -------------------------------------------------------------------------
 * 對外唯一入口，由 ConverterOrchestrator 在 tool === 'image' 時呼叫。
 * -------------------------------------------------------------------------
 */
export function start(file, options = {}) {
  const taskId = generateTaskId();
  currentTaskId = taskId;

  const worker = createEphemeralWorker('image', 'image-worker.js');
  worker.onmessage = (event) => handleWorkerMessage(event, taskId);
  worker.onerror = (errorEvent) => handleWorkerRuntimeError(errorEvent, taskId);

  worker.postMessage({
    type: 'start',
    payload: { taskId, file, options },
  });
}

function handleWorkerMessage(event, expectedTaskId) {
  const { type, payload } = event.data || {};
  if (!payload || payload.taskId !== expectedTaskId) {
    console.debug('[ImageConverter] 忽略不屬於目前任務的訊息：', event.data);
    return;
  }

  if (type === 'progress') {
    EventBus_instance.emit('converter:progress-raw', {
      tool: 'image',
      percent: payload.percent,
      label: payload.label,
    });
  } else if (type === 'result') {
    handleResult(payload);
  } else if (type === 'error') {
    handleError(payload);
  } else {
    console.warn('[ImageConverter] 收到未知的訊息類型：', type);
  }
}

function handleResult(payload) {
  const blobUrl = URL.createObjectURL(payload.blob);

  EventBus_instance.emit('converter:result', {
    tool: 'image',
    blobUrl,
    fileName: payload.fileName,
    fileSizeBytes: payload.fileSizeBytes,
  });

  // 圖片是即用即丟策略：任務成功結束，立刻銷毀 Worker，
  // 不像 FFmpeg 需要保留實例給下次任務複用。
  destroyEphemeralWorker('image', 'completed');
  currentTaskId = null;
}

function handleError(payload) {
  EventBus_instance.emit('converter:error', {
    tool: 'image',
    message: payload.message,
  });

  destroyEphemeralWorker('image', 'error');
  currentTaskId = null;
}

function handleWorkerRuntimeError(errorEvent, expectedTaskId) {
  if (currentTaskId !== expectedTaskId) return;

  console.error('[ImageConverter] Worker 發生未捕捉的原生錯誤：', errorEvent);

  EventBus_instance.emit('converter:error', {
    tool: 'image',
    message: '圖片轉檔引擎發生未預期的錯誤，請重新嘗試。',
  });

  destroyEphemeralWorker('image', 'error');
  currentTaskId = null;
}
