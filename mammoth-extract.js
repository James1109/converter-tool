/**
 * =============================================================================
 * mammoth-extract.js
 * =============================================================================
 * 把 .docx → 結構化 HTML 這件事抽成共用工具，供
 * converters/AiDocumentConverter.js 與 converters/PdfConverter.js
 * （word-to-pdf 主執行緒路徑）共用，避免同一段邏輯維護兩份。
 * =============================================================================
 */

import { loadScriptOnce } from './html-to-pdf-renderer.js';

const MAMMOTH_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.7.0/mammoth.browser.min.js';

/**
 * extractDocxHtml(file)
 * -------------------------------------------------------------------------
 * 目前僅支援 .docx（Office Open XML 格式）。舊版 .doc（Word 97-2003
 * 二進位格式）mammoth.js 本身不支援解析，這是函式庫本身的限制，
 * 不是我們架構的問題——呼叫端應該在讓使用者選擇檔案前，就用副檔名
 * 過濾掉 .doc，並在畫面上清楚說明「僅支援 .docx」。
 * -------------------------------------------------------------------------
 */
export async function extractDocxHtml(file) {
  await loadScriptOnce(MAMMOTH_CDN_URL);
  const arrayBuffer = await file.arrayBuffer();
  const result = await window.mammoth.convertToHtml({ arrayBuffer });
  if (result.messages && result.messages.length > 0) {
    console.warn('[mammoth-extract] 解析警告：', result.messages);
  }
  return result.value;
}
