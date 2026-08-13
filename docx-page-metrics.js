/**
 * =============================================================================
 * docx-page-metrics.js
 * =============================================================================
 * 【模組定位】
 * .docx 檔案本質上是一個 zip 壓縮檔，裡面的 word/document.xml 記錄了
 * 這份文件的頁面尺寸與邊界設定（Word 編輯畫面裡「版面配置」分頁設定
 * 的那些數字），格式是 <w:sectPr> 區塊底下的 <w:pgSz>（頁面寬高）跟
 * <w:pgMar>（上下左右邊界），單位是 twips（1/20 pt，1440 twips = 1 吋）。
 *
 * 標準 Word→PDF 轉檔（見 converters/PdfConverter.js）先前一直被回報
 * 「頁次跟原文對不起來」，原因之一是我們用的頁面邊界（40px 內距）
 * 遠比 Word 常見的邊界（上下 1 吋、左右 1.25 吋，換算約 96px／120px）
 * 小很多，同樣的內容我們塞得進更多行、更多字，頁面分配自然跟原始
 * Word 檔案對不太起來。這個模組直接把 Word 檔案自己記錄的頁面尺寸與
 * 邊界讀出來，讓我們的渲染容器盡量比照這份文件實際的版面設定，
 * 縮小跟原始 Word 分頁的落差。
 *
 * 【仍然無法做到完全一致的原因】
 * 就算頁面尺寸與邊界完全比照 Word 的設定，實際每一行能塞下幾個字、
 * 每一頁能塞下幾行，還是取決於「字型的實際字寬與行高」——Word 用的
 * 是它自己內部的字型測量引擎，我們這裡是瀏覽器的字型測量結果，
 * 兩者對同一款字型（甚至同名字型在不同作業系統上）的量測數字本來
 * 就不會逐像素相同。這個模組能做到「頁面尺寸/邊界跟 Word 一致」，
 * 但無法做到「換行位置、分頁位置跟 Word 逐字一致」。
 * =============================================================================
 */

import { loadScriptOnce } from './html-to-pdf-renderer.js';

const JSZIP_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

// twips（1/20 pt）轉成瀏覽器慣用的 96dpi 像素：1 吋 = 1440 twips = 96px。
function twipsToPx(twips) {
  return (twips / 1440) * 96;
}

// 找不到頁面設定，或解析失敗時的保守預設值：比照 Word 最常見的
// A4 直向、上下 1 吋／左右 1.25 吋邊界，這組數字比我們原本寫死的
// 40px 更接近一般 Word 文件的實際版面配置。
const DEFAULT_METRICS = {
  widthPx: 794,
  heightPx: 1123,
  marginTopPx: 96,
  marginRightPx: 120,
  marginBottomPx: 96,
  marginLeftPx: 120,
};

/**
 * extractDocxPageMetrics(file)
 * -------------------------------------------------------------------------
 * 回傳 { widthPx, heightPx, marginTopPx, marginRightPx, marginBottomPx,
 * marginLeftPx }。任何一步解析失敗（檔案格式異常、找不到 sectPr 等）
 * 都直接回傳 DEFAULT_METRICS，不讓這個「錦上添花」的功能中斷整個
 * 轉檔流程。
 * -------------------------------------------------------------------------
 */
export async function extractDocxPageMetrics(file) {
  try {
    await loadScriptOnce(JSZIP_CDN_URL);
    const arrayBuffer = await file.arrayBuffer();
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) return DEFAULT_METRICS;

    const xml = await documentXmlFile.async('string');

    // 一份文件裡可能有多個 <w:sectPr>（分節設定），保守起見只取第一個，
    // 對絕大多數「整份文件只有一種版面設定」的常見情況已經足夠。
    const sectPrMatch = xml.match(/<w:sectPr[^>]*>[\s\S]*?<\/w:sectPr>/);
    if (!sectPrMatch) return DEFAULT_METRICS;
    const sectPrXml = sectPrMatch[0];

    const pgSzMatch = sectPrXml.match(/<w:pgSz\s+([^/>]+)\/?>/);
    const pgMarMatch = sectPrXml.match(/<w:pgMar\s+([^/>]+)\/?>/);

    function readAttr(attrString, name) {
      const m = attrString.match(new RegExp(`w:${name}="(\\d+)"`));
      return m ? parseInt(m[1], 10) : null;
    }

    const widthTwips = pgSzMatch ? readAttr(pgSzMatch[1], 'w') : null;
    const heightTwips = pgSzMatch ? readAttr(pgSzMatch[1], 'h') : null;
    const topTwips = pgMarMatch ? readAttr(pgMarMatch[1], 'top') : null;
    const rightTwips = pgMarMatch ? readAttr(pgMarMatch[1], 'right') : null;
    const bottomTwips = pgMarMatch ? readAttr(pgMarMatch[1], 'bottom') : null;
    const leftTwips = pgMarMatch ? readAttr(pgMarMatch[1], 'left') : null;

    return {
      widthPx: widthTwips ? Math.round(twipsToPx(widthTwips)) : DEFAULT_METRICS.widthPx,
      heightPx: heightTwips ? Math.round(twipsToPx(heightTwips)) : DEFAULT_METRICS.heightPx,
      marginTopPx: topTwips ? Math.round(twipsToPx(topTwips)) : DEFAULT_METRICS.marginTopPx,
      marginRightPx: rightTwips ? Math.round(twipsToPx(rightTwips)) : DEFAULT_METRICS.marginRightPx,
      marginBottomPx: bottomTwips ? Math.round(twipsToPx(bottomTwips)) : DEFAULT_METRICS.marginBottomPx,
      marginLeftPx: leftTwips ? Math.round(twipsToPx(leftTwips)) : DEFAULT_METRICS.marginLeftPx,
    };
  } catch (err) {
    console.warn('[docx-page-metrics] 讀取頁面設定失敗，改用預設值：', err);
    return DEFAULT_METRICS;
  }
}
