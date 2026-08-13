/**
 * =============================================================================
 * docx-page-setup.js
 * =============================================================================
 * 【模組定位】
 * .docx 檔案本質上是一個 ZIP，裡面的 word/document.xml 結尾處會有一段
 * <w:sectPr>，記錄這份文件在 Word 裡實際使用的「頁面尺寸」跟「頁面
 * 邊界（margin）」；word/styles.xml 的 <w:docDefaults> 則記錄了預設
 * 字級。這個模組把這兩份資訊讀出來，換算成我們渲染器可以直接使用的
 * mm/px 數值。
 *
 * 【為什麼要多做這一步】
 * mammoth.js 專注在「把 Word 文件的內容轉成語意化的 HTML」，設計上
 * 刻意不保留頁面尺寸/邊界這類純排版資訊（這是它文件裡明講的取捨）。
 * 但我們的分頁演算法（html-to-pdf-renderer.js）需要知道「一頁到底
 * 能放多少內容」才能決定在哪裡分頁，如果我們自己憑感覺隨便訂一個
 * 邊界值（例如原本寫死的 40px），跟使用者原始 Word 文件實際設定的
 * 邊界（很可能不是我們亂猜的那個值）對不起來，分頁位置自然就會跟
 * Word 原始的分頁效果有落差。這裡直接從檔案本身讀出真正的設定值，
 * 是讓分頁結果更貼近原始 Word 文件的關鍵一步。
 *
 * 【仍然無法做到 100% 一致的原因】
 * 就算頁面尺寸、邊界、字級都跟 Word 一模一樣，瀏覽器的字型排版引擎
 * 跟 Word 自己的排版引擎在斷行、字距、行距的細節計算上仍然不會
 * 逐像素相同（尤其中英文混排、字型本身如果不是 Word 用的那一套）。
 * 這裡做的是「大幅縮小落差」，不是「保證完全一致」。
 * =============================================================================
 */

import { loadScriptOnce } from './html-to-pdf-renderer.js';

const JSZIP_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

const TWIP_TO_MM = 25.4 / 1440; // 1 twip = 1/1440 英吋
const HALF_PT_TO_PX = 96 / 72 / 2; // half-point → px（96dpi 下，1pt = 96/72 px）

// 讀取失敗、或文件本身沒有 sectPr（極少數情況）時的預設值：標準 A4 +
// Word 常見的預設邊界。
const DEFAULT_PAGE_SETUP = {
  widthMM: 210,
  heightMM: 297,
  marginTopMM: 25.4,
  marginRightMM: 31.75,
  marginBottomMM: 25.4,
  marginLeftMM: 31.75,
  baseFontSizePx: 16,
  latinFontFamily: '',
  eastAsianFontFamily: '',
};

/**
 * extractDocxPageSetup(file)
 * -------------------------------------------------------------------------
 * 回傳 { widthMM, heightMM, marginTopMM, marginRightMM, marginBottomMM,
 * marginLeftMM, baseFontSizePx }。任何一步解析失敗都直接回退到
 * DEFAULT_PAGE_SETUP，不讓「頁面設定讀取失敗」擋住整個轉檔流程
 * ——版面貼近 Word 是加分項，不是轉檔能不能成功的必要條件。
 * -------------------------------------------------------------------------
 */
export async function extractDocxPageSetup(file) {
  try {
    await loadScriptOnce(JSZIP_CDN_URL);
    const zip = await window.JSZip.loadAsync(file);

    const result = { ...DEFAULT_PAGE_SETUP };

    const documentXmlFile = zip.file('word/document.xml');
    if (documentXmlFile) {
      const documentXml = await documentXmlFile.async('text');
      // 一份文件可能有多個 <w:sectPr>（分節），我們要的是「最後一個」
      // ——代表文件主體最後使用的頁面設定，對單一 section 的一般文件
      // 來說就是唯一、也是正確的那一個。
      const sectPrMatches = [...documentXml.matchAll(/<w:sectPr[^>]*>([\s\S]*?)<\/w:sectPr>/g)];
      const lastSectPr = sectPrMatches.length > 0 ? sectPrMatches[sectPrMatches.length - 1][1] : null;

      if (lastSectPr) {
        const pgSzMatch = lastSectPr.match(/<w:pgSz\s+([^/]*)\/>/);
        if (pgSzMatch) {
          const wMatch = pgSzMatch[1].match(/w:w="(\d+)"/);
          const hMatch = pgSzMatch[1].match(/w:h="(\d+)"/);
          if (wMatch) result.widthMM = parseInt(wMatch[1], 10) * TWIP_TO_MM;
          if (hMatch) result.heightMM = parseInt(hMatch[1], 10) * TWIP_TO_MM;
        }

        const pgMarMatch = lastSectPr.match(/<w:pgMar\s+([^/]*)\/>/);
        if (pgMarMatch) {
          const attrs = pgMarMatch[1];
          const top = attrs.match(/w:top="(-?\d+)"/);
          const right = attrs.match(/w:right="(-?\d+)"/);
          const bottom = attrs.match(/w:bottom="(-?\d+)"/);
          const left = attrs.match(/w:left="(-?\d+)"/);
          if (top) result.marginTopMM = parseInt(top[1], 10) * TWIP_TO_MM;
          if (right) result.marginRightMM = parseInt(right[1], 10) * TWIP_TO_MM;
          if (bottom) result.marginBottomMM = parseInt(bottom[1], 10) * TWIP_TO_MM;
          if (left) result.marginLeftMM = parseInt(left[1], 10) * TWIP_TO_MM;
        }
      }
    }

    const stylesXmlFile = zip.file('word/styles.xml');
    if (stylesXmlFile) {
      const stylesXml = await stylesXmlFile.async('text');
      const docDefaultsMatch = stylesXml.match(/<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/);
      if (docDefaultsMatch) {
        const szMatch = docDefaultsMatch[1].match(/<w:sz\s+w:val="(\d+)"/);
        if (szMatch) {
          result.baseFontSizePx = parseInt(szMatch[1], 10) * HALF_PT_TO_PX;
        }
      }
    }

    // ---- 讀取文件實際使用的字型（theme1.xml）----
    // Word 文件裡的字型設定，常常不是直接寫死字型名稱，而是透過
    // <w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia">
    // 這種「主題參照」指到 word/theme/theme1.xml 裡定義的實際字型。
    // 這是很多繁體中文 Word 範本的常見組合：西文用 Calibri，中文用
    // 新細明體——如果我們渲染時用的是通用的 Noto Sans TC 之類的網頁
    // 字型，字寬會跟 Word 實際使用的字型不一樣，斷行位置自然對不起來。
    // 這裡把 theme1.xml 裡「minorFont」（一般內文用）的西文字型
    // （<a:latin>）跟繁體中文字型（<a:font script="Hant">）抓出來，
    // 讓渲染器優先使用文件真正指定的字型；使用者的瀏覽器/作業系統剛好
    // 有裝這個字型時，排版結果會明顯更貼近 Word 原始樣子（多數 Windows
    // 環境本來就內建新細明體、Calibri 這類 Office 常用字型）。沒有裝
    // 的話，CSS font-family 清單後面仍然接著我們原本的通用字型堆疊
    // 當保底，不會整個沒有字型可用。
    const themeXmlFile = zip.file('word/theme/theme1.xml');
    if (themeXmlFile) {
      const themeXml = await themeXmlFile.async('text');
      const minorFontMatch = themeXml.match(/<a:minorFont>([\s\S]*?)<\/a:minorFont>/);
      if (minorFontMatch) {
        const block = minorFontMatch[1];
        const latinMatch = block.match(/<a:latin\s+typeface="([^"]*)"/);
        const hantMatch = block.match(/<a:font\s+script="Hant"\s+typeface="([^"]*)"/);
        const hansMatch = block.match(/<a:font\s+script="Hans"\s+typeface="([^"]*)"/);
        if (latinMatch && latinMatch[1]) result.latinFontFamily = latinMatch[1];
        if (hantMatch && hantMatch[1]) result.eastAsianFontFamily = hantMatch[1];
        else if (hansMatch && hansMatch[1]) result.eastAsianFontFamily = hansMatch[1];
      }
    }

    // 防呆：如果讀出來的數字明顯不合理，視為解析失敗，整組回退到預設值。
    const isReasonable =
      result.widthMM > 50 && result.widthMM < 1000 && result.heightMM > 50 && result.heightMM < 1000;
    return isReasonable ? result : { ...DEFAULT_PAGE_SETUP };
  } catch (err) {
    console.warn('[docx-page-setup] 讀取頁面設定失敗，改用預設 A4 版面：', err);
    return { ...DEFAULT_PAGE_SETUP };
  }
}
