/**
 * =============================================================================
 * docx-content-audit.js
 * =============================================================================
 * 【要解決的問題】
 * mammoth.js 只認得「一般內嵌圖片」（Word 的 <w:drawing><wp:inline>
 * ...<a:blip r:embed="..."> 這種結構），對於 Word 的 **SmartArt 圖表**
 * （組織圖、流程圖等，本質上是一組向量圖形資料 + 版面配置演算法，
 * 存放在 word/diagrams/data*.xml、layout*.xml 這些檔案，跟一般圖片
 * 是完全不同的資料結構）完全不認識，也不會發出任何警告——mammoth 只是
 * 單純把整個 SmartArt 區塊當作看不懂的元素直接跳過，內容就這樣
 * 「無聲消失」，使用者只會看到轉出來的文件裡少了圖，卻不知道原因。
 *
 * 【這個模組做的事】
 * 不是「把 SmartArt 畫出來」（那需要重新實作 Word 的 SmartArt 版面
 * 演算法，是完全不同量級的工程），而是**老實檢測出「這份文件裡有
 * 幾個 SmartArt 圖表會在轉檔時消失」，讓使用者至少知道發生了什麼事**，
 * 而不是默默漏掉內容却毫無提示。
 * =============================================================================
 */

import { loadScriptOnce } from './html-to-pdf-renderer.js';

const JSZIP_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

/**
 * countUnsupportedSmartArt(file)
 * -------------------------------------------------------------------------
 * 回傳這份 .docx 裡偵測到的 SmartArt 圖表數量（依 word/diagrams/ 底下
 * 的 dataN.xml 檔案數量估算，每一個 SmartArt 圖表都會對應一份自己的
 * data*.xml）。讀取失敗一律回傳 0，不讓這個附加檢查擋住主要轉檔流程。
 * -------------------------------------------------------------------------
 */
export async function countUnsupportedSmartArt(file) {
  try {
    await loadScriptOnce(JSZIP_CDN_URL);
    const zip = await window.JSZip.loadAsync(file);

    let count = 0;
    zip.forEach((relativePath) => {
      if (/^word\/diagrams\/data\d+\.xml$/.test(relativePath)) {
        count += 1;
      }
    });
    return count;
  } catch (err) {
    console.warn('[docx-content-audit] 偵測 SmartArt 圖表失敗，略過此項檢查：', err);
    return 0;
  }
}

/**
 * extractSmartArtTextContent(file)
 * -------------------------------------------------------------------------
 * 讀出每個 SmartArt 圖表節點（word/diagrams/dataN.xml）裡的純文字內容，
 * 回傳 [{ index, items: string[] }, ...]。
 *
 * 【技術原理】
 * SmartArt 的「文字」跟「圖形版面」是分開儲存的：dataN.xml 只存資料
 * 模型（每個節點的文字、節點之間的父子關係），真正決定「畫成什麼
 * 形狀、擺在哪裡」的是另一份 layoutN.xml（版面演算法定義）。我們沒有
 * 能力重新實作版面演算法去「畫圖」，但資料模型本身結構簡單、就是
 * 一堆帶文字的節點，用簡單的正規表示式就能撈出來——這是「保留文字
 * 內容」跟「重現圖形」這兩件事在技術難度上天差地遠的原因。
 *
 * 【已知限制】
 * 1. 拿掉的只有 type="doc"（根節點，通常空白）跟 type="parTrans"／
 *    "sibTrans"（連接線節點，不帶文字），其餘一律視為內容節點。
 * 2. 抓到的文字順序是 dataN.xml 檔案內部的節點順序，大致對應「使用者
 *    在 SmartArt 編輯窗格裡由上到下輸入的順序」，但不保證跟畫面上的
 *    視覺排列順序（例如組織圖的左右分支）完全一致。
 * 3. 沒有能力還原「哪個 SmartArt 出現在文件的哪個段落之間」，因此
 *    只能整批附加在文件最後，不是插回原始位置。
 * -------------------------------------------------------------------------
 */
export async function extractSmartArtTextContent(file) {
  try {
    await loadScriptOnce(JSZIP_CDN_URL);
    const zip = await window.JSZip.loadAsync(file);

    const dataFiles = [];
    zip.forEach((relativePath) => {
      const match = relativePath.match(/^word\/diagrams\/data(\d+)\.xml$/);
      if (match) dataFiles.push({ path: relativePath, index: parseInt(match[1], 10) });
    });
    dataFiles.sort((a, b) => a.index - b.index);

    const diagrams = [];
    for (const { path, index } of dataFiles) {
      const xml = await zip.file(path).async('text');
      const ptBlocks = [...xml.matchAll(/<dgm:pt\b([^>]*)>([\s\S]*?)<\/dgm:pt>/g)];

      const items = [];
      for (const [, attrs, body] of ptBlocks) {
        const typeMatch = attrs.match(/type="([^"]*)"/);
        const type = typeMatch ? typeMatch[1] : null;
        if (type === 'doc' || type === 'parTrans' || type === 'sibTrans' || type === 'presOf') continue;

        const textRuns = [...body.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
        const text = textRuns.join('').trim();
        if (text) items.push(text);
      }

      if (items.length > 0) diagrams.push({ index, items });
    }

    return diagrams;
  } catch (err) {
    console.warn('[docx-content-audit] 讀取 SmartArt 文字內容失敗，略過此項：', err);
    return [];
  }
}

/**
 * buildSmartArtAppendixHtml(diagrams)
 * -------------------------------------------------------------------------
 * 把 extractSmartArtTextContent() 的結果組成一段「附錄」HTML，附加在
 * 文件最後。
 * -------------------------------------------------------------------------
 */
export function buildSmartArtAppendixHtml(diagrams) {
  if (!diagrams || diagrams.length === 0) return '';

  const sections = diagrams
    .map(
      (diagram, i) => `
        <div style="margin-bottom:12px;">
          <p style="font-weight:600;">SmartArt 圖表 ${i + 1}（文字內容，非原始圖形）</p>
          <ul>${diagram.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>
      `
    )
    .join('');

  return `
    <div style="page-break-before:always;margin-top:24px;">
      <h2>附錄：SmartArt 圖表文字內容</h2>
      <p style="font-size:12px;color:#64748b;">以下是原始文件中 SmartArt 圖表（組織圖、流程圖等）內的文字，因技術限制無法重現原始圖形排列，改以條列方式呈現；順序不保證與原始圖表的視覺排列完全一致。</p>
      ${sections}
    </div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
/**
 * buildSmartArtWarningHtml(count)
 * -------------------------------------------------------------------------
 * 產生要插入輸出內容最前面的警告區塊 HTML。
 * -------------------------------------------------------------------------
 */
export function buildSmartArtWarningHtml(count) {
  if (count <= 0) return '';
  return `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#92400e;">
    ⚠️ 偵測到原始文件內含 ${count} 個 SmartArt 圖表（組織圖、流程圖等向量圖形，跟一般圖片是不同的技術格式）。目前的轉檔工具尚無法重現 SmartArt 的圖形排列，因此下方內容中這些圖表的「畫面」已被省略；但圖表內的文字已整理成條列式附錄放在文件最後，供你對照。並非轉檔過程出錯——若需要完整還原圖形本身，請直接查看原始 Word 文件。一般內嵌的圖片（.png/.jpg 等）不受影響，仍會正常轉換。
  </div>`;
}
