/**
 * =============================================================================
 * converters/GithubActionsConverter.js
 * =============================================================================
 * 【模組定位】
 * 「進階轉檔（GitHub Actions + LibreOffice）」的前端邏輯。tool 名稱為
 * 'gh-actions-document'。
 *
 * 【運作方式，對應 .github/workflows/docx-to-pdf.yml】
 * 1. 使用者提供自己的 GitHub 帳號、Fork 出來的 repo 名稱、一組權限
 *    範圍已限縮的 Personal Access Token（只需要該 repo 的內容讀寫
 *    權限）。
 * 2. 用 GitHub Contents API，把要轉檔的檔案以 base64 內容 commit 到
 *    使用者 repo 的 incoming/ 目錄——這個 push 動作本身就會觸發
 *    workflow（見 .yml 檔的 on.push.paths 設定），不需要另外呼叫
 *    workflow_dispatch。
 * 3. 前端輪詢 outgoing/ 目錄，直到轉檔結果出現（GitHub Actions 那邊
 *    跑完 LibreOffice 轉檔、commit 回 repo 需要一點時間，通常
 *    30 秒～2 分鐘）。
 * 4. 抓到結果後解碼、下載，並清理 outgoing/ 裡對應的檔案。
 *
 * 【隱私與安全性】
 * Token 只會：(a) 存在使用者自己瀏覽器的 localStorage、(b) 直接送往
 * GitHub 官方 API（api.github.com），不會經過本站任何伺服器（本工具
 * 沒有伺服器）。強烈建議使用者申請的 Personal Access Token 權限範圍
 * 限縮到「只能存取這一個 repo 的內容（Contents: Read and write）」，
 * 不要給予帳號其他權限，把外洩風險降到最低——這件事我們沒辦法在程式
 * 層面強制，只能在 UI 文案裡反覆提醒。
 * =============================================================================
 */

import { EventBus_instance } from '../event-bus.js';
import { registerMainThreadTask, clearMainThreadTask } from '../worker-lifecycle.js';

const GITHUB_API_BASE = 'https://api.github.com';
const POLL_INTERVAL_MS = 6000;
const MAX_POLL_ATTEMPTS = 40; // 6s * 40 = 4 分鐘逾時
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB，見 UI 文案說明

let busy = false;
let cancelRequested = false;

export function isBusy() {
  return busy;
}

function emitProgress(percent, label) {
  EventBus_instance.emit('converter:progress-raw', { tool: 'gh-actions-document', percent, label });
}

function emitError(message) {
  EventBus_instance.emit('converter:error', { tool: 'gh-actions-document', message });
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getDefaultBranch(owner, repo, token) {
  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`找不到 repo「${owner}/${repo}」，請確認帳號名稱、repo 名稱是否正確，以及是否已經 Fork 到這個帳號底下。`);
    }
    if (response.status === 401) {
      throw new Error('GitHub Token 無效或已過期，請重新申請一組。');
    }
    throw new Error(`無法讀取 repo 資訊（HTTP ${response.status}），請確認 Token 是否有這個 repo 的存取權限。`);
  }
  const data = await response.json();
  return data.default_branch || 'main';
}

async function uploadIncomingFile(owner, repo, branch, token, path, base64Content) {
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `docx-to-pdf: upload ${path}`,
        content: base64Content,
        branch,
      }),
    }
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`上傳檔案到 GitHub 失敗（HTTP ${response.status}）：請確認 Token 權限是否包含這個 repo 的「Contents: Read and write」。${body ? ' ' + body.slice(0, 200) : ''}`);
  }
}

async function pollForOutputFile(owner, repo, branch, token, dirPath, taskId, onProgress) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (cancelRequested) throw new Error('已取消轉檔。');

    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(dirPath)}?ref=${branch}`,
      { headers: authHeaders(token) }
    );
    if (response.status === 200) {
      const items = await response.json();
      const match = Array.isArray(items) ? items.find((item) => item.name.startsWith(`${taskId}.`)) : null;
      if (match) return match;
    } else if (response.status !== 404) {
      throw new Error(`查詢轉檔結果時發生錯誤（HTTP ${response.status}）。`);
    }

    onProgress(attempt);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('等待 GitHub Actions 轉檔逾時（超過 4 分鐘）。請到你的 repo 的 Actions 分頁查看實際執行狀況，可能是免費額度用盡或工作流程執行失敗。');
}

async function deleteFile(owner, repo, branch, token, path, sha) {
  try {
    await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method: 'DELETE',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `docx-to-pdf: cleanup ${path}`, sha, branch }),
    });
  } catch (err) {
    // 清理失敗不影響主流程，使用者已經拿到轉檔結果了，這裡只記錄即可。
    console.warn('[GithubActionsConverter] 清理暫存檔案失敗（不影響轉檔結果）：', err);
  }
}

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  html: 'text/html',
  zip: 'application/zip', // png/jpg 輸出是多頁圖片包成的 zip
};

/**
 * start(file, options)
 * -------------------------------------------------------------------------
 * options: { owner, repo, token, targetFormat }
 * targetFormat: 'pdf' | 'html' | 'png' | 'jpg'（省略時預設 'pdf'）
 * -------------------------------------------------------------------------
 */
export async function start(file, options) {
  if (busy) return;

  const owner = (options.owner || '').trim();
  const repo = (options.repo || '').trim();
  const token = (options.token || '').trim();
  const targetFormat = (options.targetFormat || 'pdf').trim().toLowerCase();

  if (!owner || !repo || !token) {
    emitError('請先填寫 GitHub 帳號、repo 名稱與 Personal Access Token 才能使用精準轉檔功能。');
    return;
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    emitError(`檔案大小超過 ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB 上限，GitHub Contents API 對單次上傳的檔案大小有限制，請改用較小的檔案。`);
    return;
  }

  busy = true;
  cancelRequested = false;
  registerMainThreadTask('gh-actions-document', {
    onCancel: () => {
      cancelRequested = true;
    },
  });

  try {
    emitProgress(5, '正在確認 repo 資訊...');
    const branch = await getDefaultBranch(owner, repo, token);

    const uuid =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ext = (file.name.match(/\.[^.]+$/) || ['.docx'])[0];
    const baseName = file.name.replace(/\.[^.]+$/, '');
    // 目標格式用「子資料夾名稱」表達，見 docx-to-pdf.yml 檔頭說明。
    const incomingPath = `incoming/${targetFormat}/${uuid}${ext}`;
    const outgoingDir = `outgoing/${targetFormat}`;

    emitProgress(15, '正在上傳檔案到 GitHub...');
    const base64Content = await fileToBase64(file);
    await uploadIncomingFile(owner, repo, branch, token, incomingPath, base64Content);

    emitProgress(25, 'GitHub Actions 已觸發，正在等待 LibreOffice 轉檔（通常需要 30 秒～2 分鐘）...');
    const match = await pollForOutputFile(owner, repo, branch, token, outgoingDir, uuid, (attempt) => {
      // 25% ~ 90% 之間依嘗試次數緩慢推進，讓使用者知道還在等，不是卡住。
      const percent = Math.min(90, 25 + (attempt / MAX_POLL_ATTEMPTS) * 65);
      emitProgress(percent, 'GitHub Actions 正在轉檔中，請耐心等候...');
    });

    emitProgress(95, '正在下載轉檔結果...');
    const resultExt = (match.name.match(/\.[^.]+$/) || ['.pdf'])[0].slice(1);
    const mimeType = MIME_BY_EXT[resultExt] || 'application/octet-stream';

    // 用 download_url 直接抓原始內容（公開 repo 不需要額外帶 token 也能
    // 讀到，比再打一次 contents API、自己解 base64 更單純直接）。
    const fileResponse = await fetch(match.download_url);
    if (!fileResponse.ok) {
      throw new Error(`下載轉檔結果失敗（HTTP ${fileResponse.status}）。`);
    }
    const resultBlob = await fileResponse.blob();
    const typedBlob = new Blob([resultBlob], { type: mimeType });
    const blobUrl = URL.createObjectURL(typedBlob);

    const outputSuffix = resultExt === 'zip' ? '-圖片' : '';
    EventBus_instance.emit('converter:result', {
      tool: 'gh-actions-document',
      blobUrl,
      fileName: `${baseName}${outputSuffix}.${resultExt}`,
      fileSizeBytes: typedBlob.size,
    });

    // 清理 GitHub 上的暫存輸出檔案（不影響已經下載到本機的結果）。
    deleteFile(owner, repo, branch, token, match.path, match.sha);
  } catch (err) {
    console.error('[GithubActionsConverter] 轉檔失敗：', err);
    emitError(err && err.message ? err.message : '精準轉檔過程發生未知錯誤，請重新嘗試。');
  } finally {
    busy = false;
    clearMainThreadTask('gh-actions-document', 'completed');
  }
}
