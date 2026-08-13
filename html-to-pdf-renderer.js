/**
 * =============================================================================
 * html-to-pdf-renderer.js
 * =============================================================================
 * 【模組定位】
 * 把「一段 HTML 字串 → 排版好的 PDF」這件事抽成共用工具，同時被
 * converters/AiDocumentConverter.js（AI 處理過的內容）與
 * converters/PdfConverter.js（Word→PDF 標準轉檔）共用。
 *
 * 【為什麼不用 pdf-lib 手動排版】見 converters/PdfConverter.js 檔頭
 * 說明：pdf-lib/fontkit 的連字（ligature）替換跟手刻排版邏輯衝突，
 * 會造成文字疊字/亂碼，改用 html2canvas 螢幕截圖式渲染從根本避開。
 *
 * 【第四次修正：改成「量測後手動分頁」，而不是單頁長圖或 html2pdf.js
 * 的自動分頁】
 * 前面幾版分別試過：
 *   1. html2pdf.js 內建的 A4 自動分頁 → 分頁演算法本身不穩定，量出來
 *      的分頁位置常常跟實際內容對不上，出現整段空白。
 *   2. 改成「單一長頁、頁高等於內容總長」 → 不會有分頁空白 bug 了，
 *      但輸出永遠只有一頁，跟 Word 那種一頁一頁的原始外觀差太多，
 *      使用者會覺得「頁數不對」。
 * 這一版改成**先在真實 DOM 裡量測每個區塊（段落/表格/標題...）的
 * 實際高度，再由我們自己的程式碼依 A4 版面可用高度把區塊分組**，
 * 每一組各自對應輸出 PDF 的一頁，每一頁各自單獨呼叫一次
 * html2canvas（頁面尺寸在呼叫前就已知、固定），最後用 jsPDF 把每一頁
 * 依序組成多頁 PDF。因為每一頁的畫布尺寸都是「已知固定的 A4 版面」，
 * 不需要任何「把一張長畫布硬切成好幾份」的分頁演算法，也就不會再
 * 出現前兩版那些對不齊、算錯高度的問題。
 *
 * 這個做法可以做到「排版起來像 Word 一頁一頁」的效果，但仍然無法
 * 保證跟 Word 原始檔案的頁數完全一致——因為 Word 自己的分頁是依照
 * Word 內部字型測量引擎、版面邊界即時算出來的，我們這裡用的是瀏覽器
 * 的字型測量結果，兩者本來就不會逐像素相同。這是純前端技術路線的
 * 已知限制，不是本檔案這次修正能解決的問題。
 * =============================================================================
 */

const loadedScriptUrls = new Set();

export function loadScriptOnce(url) {
  if (loadedScriptUrls.has(url)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => {
      loadedScriptUrls.add(url);
      resolve();
    };
    script.onerror = () => reject(new Error(`無法載入外部函式庫：${url}`));
    document.head.appendChild(script);
  });
}

function waitTwoAnimationFrames() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

const HTML2CANVAS_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
const JSPDF_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

const MM_TO_PX = 96 / 25.4; // 96dpi

/**
 * renderHtmlToPdfBlob(bodyHtml, title, pageSetup)
 * -------------------------------------------------------------------------
 * 把一段 HTML body 內容渲染成多頁 PDF（頁數依內容實際長度自然分頁，
 * 不使用任何自動分頁演算法），回傳 Blob。
 *
 * pageSetup（選填，省略時退回 A4 + 標準邊界的預設值）：
 *   { widthMM, heightMM, marginTopMM, marginRightMM, marginBottomMM,
 *     marginLeftMM, baseFontSizePx }
 * 由呼叫端（例如 docx-page-setup.js 從原始 .docx 讀出來的實際頁面
 * 設定）決定；把頁面尺寸/邊界/字級變成參數而不是寫死常數，是為了讓
 * Word→PDF 的分頁結果可以貼近使用者原始文件的實際版面設定，而不是
 * 我們自己隨便猜的一組數字。
 * -------------------------------------------------------------------------
 */
export async function renderHtmlToPdfBlob(bodyHtml, title, pageSetup = {}) {
  await Promise.all([loadScriptOnce(HTML2CANVAS_CDN_URL), loadScriptOnce(JSPDF_CDN_URL)]);

  // ⭐ 修正「表格框線、標題字級等共用樣式消失」的 bug ⭐
  // 分頁時，內容節點會從 measureContainer 被搬到各自獨立的 pageShell
  // 容器裡（見下方），但原本共用的 <style> 標籤（表格框線、標題字級
  // 這些規則）是寫在 measureContainer 內、且被明確排除在「要搬去
  // pageShell」的節點名單之外——量測完 measureContainer 就整個被移除
  // 了，這份樣式表也跟著消失，之後每一頁單獨截圖時自然就沒有框線、
  // 沒有標題字級這些效果。
  // 改成把這份共用樣式直接掛在 document.head 上（整個轉檔過程的全域
  // 樣式，不綁定在任何一個會被搬移/移除的容器裡），所有頁面截圖時都
  // 能吃到同一份樣式，轉檔結束後才移除，不會汙染頁面正常瀏覽時的
  // 樣式。
  const globalStyleEl = document.createElement('style');
  globalStyleEl.textContent = `
    .converter-pdf-render-root * { margin: 0; }
    .converter-pdf-render-root table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
    .converter-pdf-render-root td, .converter-pdf-render-root th { border: 1px solid #cbd5e1; padding: 6px 8px; }
    .converter-pdf-render-root h1, .converter-pdf-render-root h2, .converter-pdf-render-root h3 {
      font-weight: 700; margin-top: 20px; margin-bottom: 8px;
    }
    .converter-pdf-render-root h1 { font-size: 22px; }
    .converter-pdf-render-root h2 { font-size: 18px; }
    .converter-pdf-render-root h3 { font-size: 16px; }
    .converter-pdf-render-root p, .converter-pdf-render-root ul, .converter-pdf-render-root ol {
      margin-bottom: 12px;
    }
    .converter-pdf-render-root li { margin-bottom: 4px; }
    .converter-pdf-render-root :first-child { margin-top: 0; }
    .converter-pdf-render-root img { max-width: 100%; }
  `;
  document.head.appendChild(globalStyleEl);

  const widthMM = pageSetup.widthMM || 210;
  const heightMM = pageSetup.heightMM || 297;
  const marginTopPx = (pageSetup.marginTopMM ?? 25.4) * MM_TO_PX;
  const marginRightPx = (pageSetup.marginRightMM ?? 25.4) * MM_TO_PX;
  const marginBottomPx = (pageSetup.marginBottomMM ?? 25.4) * MM_TO_PX;
  const marginLeftPx = (pageSetup.marginLeftMM ?? 25.4) * MM_TO_PX;
  const baseFontSizePx = pageSetup.baseFontSizePx || 16;

  // ⭐ 優先使用文件實際指定的字型（見 docx-page-setup.js 的說明），
  // 使用者裝置上剛好有這個字型的話，斷行/字寬會更貼近 Word 原始樣子；
  // 沒有的話，落回我們原本的通用中文字型堆疊當保底，一定會有字可顯示。
  const fontStackParts = [];
  if (pageSetup.eastAsianFontFamily) fontStackParts.push(`'${pageSetup.eastAsianFontFamily}'`);
  if (pageSetup.latinFontFamily) fontStackParts.push(`'${pageSetup.latinFontFamily}'`);
  fontStackParts.push("'Noto Sans TC'", "'PingFang TC'", "'Microsoft JhengHei'", "'Heiti TC'", 'sans-serif');
  const fontFamilyStack = fontStackParts.join(', ');

  const pageWidthPx = widthMM * MM_TO_PX;
  const pageHeightPx = heightMM * MM_TO_PX;
  const contentWidthPx = pageWidthPx - marginLeftPx - marginRightPx;
  const contentHeightPx = pageHeightPx - marginTopPx - marginBottomPx;

  function makePageShell() {
    const shell = document.createElement('div');
    shell.className = 'converter-pdf-render-root';
    shell.style.width = `${pageWidthPx}px`;
    shell.style.minHeight = `${pageHeightPx}px`;
    shell.style.boxSizing = 'border-box';
    shell.style.paddingTop = `${marginTopPx}px`;
    shell.style.paddingRight = `${marginRightPx}px`;
    shell.style.paddingBottom = `${marginBottomPx}px`;
    shell.style.paddingLeft = `${marginLeftPx}px`;
    shell.style.background = '#ffffff';
    shell.style.fontFamily = fontFamilyStack;
    shell.style.fontSize = `${baseFontSizePx}px`;
    shell.style.lineHeight = '1.6';
    shell.style.color = '#1e293b';
    shell.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.06)';
    shell.style.marginBottom = '16px';
    return shell;
  }

  /**
   * isOrphanProneIntro(node)
   * -----------------------------------------------------------------------
   * 判斷這個節點是不是「引言/小標題」性質的內容——標題（h1~h3），或是
   * 一句很短、以冒號結尾的段落（例如「在 pubspec.yaml 加入：」）。這種
   * 內容本來就是用來「帶出下一段/下一張表格」的，如果剛好卡在一頁的
   * 最後一行、它要介紹的內容卻被擠到下一頁去，讀起來會很奇怪（俗稱
   * 「孤行」問題）。
   * -----------------------------------------------------------------------
   */
  function isOrphanProneIntro(node) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') return true;
    if (tag === 'p') {
      const text = (node.textContent || '').trim();
      if (text.length > 0 && text.length < 60 && /[:：]$/.test(text)) return true;
    }
    return false;
  }

  function splitIntoPageGroups(nodes) {
    const groups = [];
    let currentGroup = [];
    let currentHeight = 0;

    nodes.forEach((child) => {
      const childHeight = child.offsetHeight;
      if (currentGroup.length > 0 && currentHeight + childHeight > contentHeightPx) {
        groups.push(currentGroup);
        currentGroup = [];
        currentHeight = 0;
      }
      currentGroup.push(child);
      currentHeight += childHeight;
    });

    if (currentGroup.length > 0) groups.push(currentGroup);

    // ⭐ 修正「引言句卡在頁尾、內容卻跑到下一頁」的孤行問題 ⭐
    // 依高度分組只看「加起來會不會超過一頁」，不知道「這一句其實是
    // 在介紹接下來的內容」這種語意關係。這裡分組完之後再補一輪檢查：
    // 如果某一頁的最後一個節點是「引言/小標題」性質，就把它移到下一
    // 頁的最前面，讓它跟它要介紹的內容留在同一頁。只有在這一頁「不會
    // 因此變成空頁」的情況下才移動，避免製造出真正的空白頁。
    for (let i = 0; i < groups.length - 1; i += 1) {
      const group = groups[i];
      while (group.length > 1 && isOrphanProneIntro(group[group.length - 1])) {
        const moved = group.pop();
        groups[i + 1].unshift(moved);
      }
    }

    return groups;
  }

  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '999999';
  overlay.style.background = '#f1f5f9';
  overlay.style.overflow = 'auto';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  overlay.style.alignItems = 'center';
  overlay.style.padding = '24px 0';

  const badge = document.createElement('div');
  badge.style.position = 'fixed';
  badge.style.top = '12px';
  badge.style.left = '50%';
  badge.style.transform = 'translateX(-50%)';
  badge.style.background = '#0f172a';
  badge.style.color = '#fff';
  badge.style.padding = '6px 14px';
  badge.style.borderRadius = '999px';
  badge.style.fontSize = '13px';
  badge.style.fontFamily = 'sans-serif';
  badge.style.zIndex = '1000000';
  badge.textContent = '正在產生 PDF，請稍候...';
  overlay.appendChild(badge);

  // ---- 第一步：先用一個「內容寬度跟頁面可用寬度一樣，但高度不限制」
  //       的量測容器，把所有內容塞進去，量出每個區塊的實際高度 ----
  const measureContainer = document.createElement('div');
  measureContainer.className = 'converter-pdf-render-root';
  measureContainer.style.width = `${contentWidthPx}px`;
  measureContainer.style.fontFamily = fontFamilyStack;
  measureContainer.style.fontSize = `${baseFontSizePx}px`;
  measureContainer.style.lineHeight = '1.6';
  measureContainer.style.color = '#1e293b';
  measureContainer.innerHTML = bodyHtml;
  overlay.appendChild(measureContainer);
  document.body.appendChild(overlay);

  try {
    await waitTwoAnimationFrames();
    if (measureContainer.offsetHeight === 0) {
      throw new Error('內容渲染異常（版面高度為 0），請重新嘗試一次；若持續發生請回報。');
    }

    // ⭐ 修正「所有內容擠在同一頁」的 bug ⭐
    // 量測「每個區塊實際高度」這件事，必須在節點還連著（attached）在
    // 真實文件樹（measureContainer 仍在 document.body 底下）的狀態下
    // 進行——先前版本把這些節點搬到一個「從沒被加進畫面過」的
    // groupHost 容器裡才量測，脫離文件樹的元素 offsetHeight 永遠是
    // 0，導致「目前這組的高度加起來會不會超過一頁」這個判斷式永遠
    // 不成立，於是所有內容都被分進同一組、擠成一頁。
    // 這裡改成「趁節點還在 measureContainer 裡（還連著畫面）的時候
    // 先量好、分組」，決定好分頁位置後，才把節點一組一組搬到各自的
    // pageShell 裡（appendChild 本來就會自動把節點從舊的父層移出，
    // 不需要額外處理）。
    const contentNodes = Array.from(measureContainer.children);
    const pageGroups = splitIntoPageGroups(contentNodes);

    if (pageGroups.length === 0) {
      throw new Error('內容渲染異常（沒有可輸出的內容），請重新嘗試一次；若持續發生請回報。');
    }

    // ---- 第二步：依分組結果，逐頁建立實際要截圖的頁面容器 ----
    measureContainer.remove();
    const { jsPDF } = window.jspdf;
    let finalPdf = null;

    for (let i = 0; i < pageGroups.length; i += 1) {
      const pageShell = makePageShell();
      pageGroups[i].forEach((node) => pageShell.appendChild(node));
      overlay.appendChild(pageShell);
      await waitTwoAnimationFrames();

      const canvas = await window.html2canvas(pageShell, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
      });
      const imageData = canvas.toDataURL('image/jpeg', 0.95);

      if (!finalPdf) {
        finalPdf = new jsPDF({ unit: 'mm', format: [widthMM, heightMM], orientation: 'portrait' });
      } else {
        finalPdf.addPage([widthMM, heightMM], 'portrait');
      }
      finalPdf.addImage(imageData, 'JPEG', 0, 0, widthMM, heightMM);

      pageShell.remove();
    }

    const pdfBlob = finalPdf.output('blob');

    if (pdfBlob.size < 2000) {
      throw new Error('產生的 PDF 內容看起來是空白的，請重新嘗試一次；若持續發生，可能是原始文件內容過於複雜，請回報。');
    }

    return pdfBlob;
  } finally {
    overlay.remove();
    globalStyleEl.remove();
  }
}
