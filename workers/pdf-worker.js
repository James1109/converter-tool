/**
 * =============================================================================
 * workers/pdf-worker.js
 * =============================================================================
 * 【'word-to-pdf' 升級：保留基礎排版樣式，不再只是純文字】
 *
 * 改用 mammoth.convertToHtml()（取代先前的 extractRawText()），保留
 * Word 文件的語意結構（粗體、標題、清單、程式碼區塊），再自己寫一個
 * 輕量的 HTML → pdf-lib 排版引擎，把這些結構畫成有基本樣式的 PDF。
 *
 * 【已知限制，誠實列出】
 * - 粗體：用「同一行文字疊印兩次、些微水平位移」的 faux bold 技巧模擬，
 *   因為 FontCacheManager 只快取了一種字重（Regular），沒有真正的
 *   Bold 字型檔可用。
 * - 斜體：沒有 Italic 字型檔，無法做視覺區分，文字內容仍會保留。
 * - 程式碼區塊偵測：採用兩種偵測管道 —— (1) 表格：Word 文件裡常見的
 *   「程式碼區塊」實務上很多是用表格（套用預設樣式讓視覺上有灰底
 *   框線）做出來的，而非透過段落樣式命名，mammoth 會把表格正確轉換
 *   成 <table>，這裡會抓出每個儲存格內的段落當作程式碼的每一行；
 *   (2) 段落樣式名稱：額外透過 mammoth 的 styleMap，比對是否為
 *   「Code」「Source Code」等常見命名並映射成 <pre> 標籤，作為表格
 *   以外的備援偵測方式。若兩種都偵測不到，該段落會退回一般段落樣式
 *   繼續正確顯示文字內容（不會遺失內容，只是少了底色與等寬排版）。
 * - 更複雜的版面元素（多欄表格的欄位對齊、圖片、頁首頁尾）目前不
 *   支援，會被忽略或簡化（文字內容仍會保留在段落流裡）。
 * - <br> 換行標記目前未特別處理（Word 文件的段落多半用獨立段落而非
 *   段落內強制換行表示，屬於較少見的情況）。
 * =============================================================================
 */

const MAMMOTH_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.7.0/mammoth.browser.min.js';
const PDF_LIB_CDN_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const FONTKIT_CDN_URL = 'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js';

const loadedScriptUrls = new Set();

function postToMain(type, payload = {}) {
  self.postMessage({ type, payload });
}

function buildOutputFileName(originalName) {
  const dotIndex = originalName.lastIndexOf('.');
  const baseName = dotIndex === -1 ? originalName : originalName.slice(0, dotIndex);
  return `${baseName}-converted.pdf`;
}

async function loadUmdScript(url) {
  if (loadedScriptUrls.has(url)) return;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`無法載入外部函式庫（HTTP ${response.status}）：${url}`);
  }
  const sourceCode = await response.text();
  (0, eval)(sourceCode);
  loadedScriptUrls.add(url);
}

// -------------------------------------------------------------------------
// 中日韓字元／一般詞彙的斷詞正規表示式，跟先前版本的 wrapText() 用的
// 是同一套規則：中文逐字斷行、英數字整詞不斷行、空白單獨成一個 token
// 方便判斷詞彙間隔。
// -------------------------------------------------------------------------
const TOKENIZE_REGEX = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]|[^\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\s]+|\s+/g;

/**
 * sanitizeForStandardFont(text)
 * -------------------------------------------------------------------------
 * 優雅降級用：標準內建字型（Helvetica）只支援 WinAnsiEncoding，超出範圍
 * 的字元（例如中文）一律換成 '?'，避免 pdf-lib 的 drawText() 因為無法
 * 編碼而直接拋出例外。
 * -------------------------------------------------------------------------
 */
function sanitizeForStandardFont(text) {
  return Array.from(text)
    .map((ch) => (ch.codePointAt(0) <= 0xff ? ch : '?'))
    .join('');
}

// =========================================================================
// HTML 解析：把 mammoth 產生的 HTML 轉成一份簡化的「區塊清單」
// =========================================================================
// ⭐ 重要修正 ⭐ 原本用 Worker 全域的 DOMParser 解析 HTML，實測發現
// 這個 API 在部分瀏覽器的 Worker 執行環境下並不存在（拋出
// "DOMParser is not defined"）。改成完全自己手刻、以正規表示式為基礎
// 的輕量 HTML 解析器，不依賴任何 DOM API，因此在任何 Worker 環境下
// 都能穩定運作。mammoth 輸出的 HTML 結構相對單純可預期，不需要一個
// 完整通用的 HTML Parser，只要能正確處理「標籤配對」（含同名標籤的
// 巢狀情況）與「粗體/斜體的巢狀狀態」就足夠應付目前的需求範圍。
// =========================================================================

/** 解碼 mammoth 輸出 HTML 裡常見的實體字元。 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 去除所有標籤、只留純文字（供程式碼區塊等不需要樣式的場合使用）。 */
function stripTags(html) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ''));
}

/**
 * extractTagContent(html, tagName, searchFromIndex)
 * -------------------------------------------------------------------------
 * 從 searchFromIndex 開始尋找第一個 <tagName ...> 開始標籤，並正確配對
 * 到對應的結束標籤（會計算同名標籤的巢狀深度，確保遇到巢狀的同名標籤
 * 時不會提早在內層的結束標籤就誤判為配對完成）。
 * 回傳 { innerHtml, endIndex }（endIndex 是結束標籤之後的字串位置），
 * 找不到就回傳 null。
 * -------------------------------------------------------------------------
 */
function extractTagContent(html, tagName, searchFromIndex) {
  const openRegex = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'i');
  const searchArea = html.slice(searchFromIndex);
  const openMatch = openRegex.exec(searchArea);
  if (!openMatch) return null;

  const contentStart = searchFromIndex + openMatch.index + openMatch[0].length;
  const tagPattern = new RegExp(`<${tagName}(\\s[^>]*)?>|</${tagName}\\s*>`, 'gi');
  tagPattern.lastIndex = contentStart;

  let depth = 1;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    if (match[0].charAt(1) === '/') {
      depth -= 1;
      if (depth === 0) {
        return { innerHtml: html.slice(contentStart, match.index), endIndex: match.index + match[0].length };
      }
    } else {
      depth += 1;
    }
  }
  // 沒找到正確配對的結束標籤（HTML 不完整），保守地把剩餘全部內容當作
  // 這個標籤的內容，避免直接拋出例外中斷整個轉檔流程。
  return { innerHtml: html.slice(contentStart), endIndex: html.length };
}

/**
 * findAllTagContents(html, tagName)
 * -------------------------------------------------------------------------
 * 找出字串中「任何深度」出現的所有 <tagName> 區塊內容（不限定只在頂層），
 * 依照出現順序回傳內容陣列。用於表格儲存格內抓取所有 <p>、清單內抓取
 * 所有 <li> 這類「不論巢狀多深、只要是這個標籤就要」的情境。
 * -------------------------------------------------------------------------
 */
function findAllTagContents(html, tagName) {
  const results = [];
  const openRegex = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'gi');
  let match;
  while ((match = openRegex.exec(html)) !== null) {
    const result = extractTagContent(html, tagName, match.index);
    if (!result) break;
    results.push(result.innerHtml);
    openRegex.lastIndex = result.endIndex;
  }
  return results;
}

/**
 * splitTopLevelBlocks(html)
 * -------------------------------------------------------------------------
 * 掃描字串「最外層」出現的 h1-h6/p/ul/ol/table 標籤（利用
 * extractTagContent 正確跳過每個區塊的完整內容，確保巢狀在表格/清單
 * 裡面的 <p> 不會被誤判成頂層區塊），回傳 [{ tag, html }, ...]。
 * -------------------------------------------------------------------------
 */
function splitTopLevelBlocks(html) {
  const blocks = [];
  const topTagPattern = /<(h[1-6]|p|ul|ol|table|pre)(\s[^>]*)?>/gi;
  let match;
  while ((match = topTagPattern.exec(html)) !== null) {
    const tagName = match[1].toLowerCase();
    const result = extractTagContent(html, tagName, match.index);
    if (!result) continue;
    blocks.push({ tag: tagName, html: result.innerHtml });
    topTagPattern.lastIndex = result.endIndex;
  }
  return blocks;
}

/**
 * extractRunsFromHtml(innerHtml)
 * -------------------------------------------------------------------------
 * 掃描一段內文 HTML（例如一個 <p> 的內容），依序切出文字片段，並追蹤
 * <strong>/<b>/<em>/<i> 標籤的巢狀深度，決定每個文字片段當下是否處於
 * 粗體/斜體狀態。用「深度計數」（開始標籤 +1、結束標籤 -1）而不是單純
 * 布林值，可以正確處理巢狀狀況（例如 <strong>文字<em>文字</em>文字
 * </strong> 這種情況，離開 </em> 後仍然記得自己還在 <strong> 裡面）。
 * 未支援的標籤（例如 <br>）會被靜默跳過，不會拋出例外。
 * -------------------------------------------------------------------------
 */
function extractRunsFromHtml(innerHtml) {
  const runs = [];
  const tokenPattern = /<\/?(strong|b|em|i)\b[^>]*>|[^<]+/gi;
  let boldDepth = 0;
  let italicDepth = 0;
  let match;

  while ((match = tokenPattern.exec(innerHtml)) !== null) {
    const token = match[0];
    if (token.charAt(0) === '<') {
      const isClosing = token.charAt(1) === '/';
      const tagName = token.replace(/[<>\/]/g, '').split(/\s/)[0].toLowerCase();
      if (tagName === 'strong' || tagName === 'b') {
        boldDepth += isClosing ? -1 : 1;
      } else if (tagName === 'em' || tagName === 'i') {
        italicDepth += isClosing ? -1 : 1;
      }
    } else {
      const text = decodeHtmlEntities(token);
      if (text) {
        runs.push({ text, bold: boldDepth > 0, italic: italicDepth > 0 });
      }
    }
  }

  return runs;
}

/**
 * parseHtmlIntoBlocks(htmlString)
 * -------------------------------------------------------------------------
 * 把 mammoth 輸出的 HTML 字串轉成排版引擎看得懂的簡化區塊清單：
 *   { type: 'heading', level, runs }
 *   { type: 'paragraph', runs }
 *   { type: 'listItem', ordered, index, runs }
 *   { type: 'code', text }
 * -------------------------------------------------------------------------
 */
function parseHtmlIntoBlocks(htmlString) {
  const topBlocks = splitTopLevelBlocks(htmlString);
  const blocks = [];

  for (const { tag, html: inner } of topBlocks) {
    if (/^h[1-6]$/.test(tag)) {
      blocks.push({ type: 'heading', level: Number(tag[1]), runs: extractRunsFromHtml(inner) });
      continue;
    }

    if (tag === 'p') {
      const runs = extractRunsFromHtml(inner);
      // mammoth 有時會把空段落（純換行間隔）輸出成空的 <p></p>，
      // 這種情況下 runs 會是空陣列，略過不畫，避免產生多餘的空白行。
      if (runs.length > 0) {
        blocks.push({ type: 'paragraph', runs });
      }
      continue;
    }

    if (tag === 'ul' || tag === 'ol') {
      const liContents = findAllTagContents(inner, 'li');
      let index = 1;
      for (const liInner of liContents) {
        blocks.push({ type: 'listItem', ordered: tag === 'ol', index, runs: extractRunsFromHtml(liInner) });
        index += 1;
      }
      continue;
    }

    if (tag === 'pre') {
      const codeText = stripTags(inner);
      if (codeText.trim()) {
        blocks.push({ type: 'code', text: codeText });
      }
      continue;
    }

    if (tag === 'table') {
      // ⭐ 關鍵修正 ⭐ 實測發現：使用者文件裡「看起來像程式碼區塊」的
      // 段落，在 Word 原始檔案裡其實是用「表格」做出來的（Word 會給
      // 表格套用預設樣式讓視覺上有灰底框線），而非透過段落樣式命名。
      // mammoth 會把表格正確轉換成 <table>/<tr>/<td> 結構，這裡用
      // findAllTagContents() 抓出表格內任何深度的所有 <p>（通常一格
      // 一行程式碼），依序當作程式碼的每一行接起來。
      let lines = findAllTagContents(inner, 'p').map(stripTags);
      if (lines.length === 0) {
        // 少數情況下儲存格內容不是用 <p> 包裹，退而求其次直接取
        // <td>/<th> 的純文字內容。
        lines = findAllTagContents(inner, 'td').map(stripTags);
        if (lines.length === 0) {
          lines = findAllTagContents(inner, 'th').map(stripTags);
        }
      }
      const codeText = lines.join('\n');
      if (codeText.trim()) {
        blocks.push({ type: 'code', text: codeText });
      }
      continue;
    }
  }

  return blocks;
}

// =========================================================================
// 排版引擎：把 runs 斷行、依區塊類型畫到 pdf-lib 的頁面上
// =========================================================================

function tokenizeRuns(runs) {
  const tokens = [];
  for (const run of runs) {
    const parts = run.text.match(TOKENIZE_REGEX) || [];
    for (const part of parts) {
      tokens.push({ text: part, bold: run.bold, italic: run.italic });
    }
  }
  return tokens;
}

/**
 * wrapTokensIntoLines(font, fontSize, tokens, maxWidth)
 * -------------------------------------------------------------------------
 * 把一串帶有樣式標記的 token 依照可用寬度包成多行，回傳
 * Array<Array<token>>。跟先前版本的差異：先前是處理單一字串、單一樣式；
 * 這裡要處理「同一行裡混雜著粗體與非粗體 token」的情況，因此改成
 * 直接操作 token 陣列而不是字串串接。
 * -------------------------------------------------------------------------
 */
/**
 * measureTokenWidth(font, token, fontSize)
 * -------------------------------------------------------------------------
 * ⭐ 防禦性修正：避免字型缺字導致內容「靜默消失」⭐
 *
 * 背景：實測發現某些常見中文字（例如「設」「與」「到」「立」）在畫面上
 * 完全消失，前後文字直接貼在一起、沒有任何空隙。推測原因是：
 * `font.widthOfTextAtSize()` 對某些字符（無論是真的缺字、還是 fontkit
 * 解析該字型時的某種邊界情況）回傳了 0 或無效值，導致游標沒有往前
 * 推進，下一個字就疊印在同一個位置，視覺上完全看不出來曾經有過這個
 * 字——這種「沒有任何錯誤訊息、內容卻悄悄消失」的情況是最危險的，
 * 使用者很可能完全不會注意到內容有缺漏。
 *
 * 防禦做法：每次量測字符寬度時，若結果不是合理的正數，就直接把這個
 * token 的文字換成看得見的「?」符號，並在 Console 記錄警告。這樣做
 * 保證：
 *   1. 絕對不會再有「內容默默消失」的情況——出問題一定會在畫面上
 *      留下清楚可見的「?」痕跡，使用者跟開發者都能立刻察覺。
 *   2. 不會因為單一字符有問題就整份文件放棄使用自訂字型改用預設
 *      字型（那樣殺傷力太大，會讓其他原本正常的中文字也變成問號）。
 * -------------------------------------------------------------------------
 */
function measureTokenWidth(font, token, fontSize) {
  let width = font.widthOfTextAtSize(token.text, fontSize);

  if (!Number.isFinite(width) || width <= 0) {
    console.warn(
      `[pdf-worker] 字符「${token.text}」量測寬度異常（可能是字型缺字或解析問題），已替換成「?」以避免內容靜默消失。`
    );
    token.text = '?';
    width = font.widthOfTextAtSize('?', fontSize);
    // 連 '?' 這個基本 ASCII 字元都量不出寬度的話，代表字型本身可能有
    // 更嚴重的問題，這裡給一個保守的預設寬度，確保排版邏輯不會因為
    // 拿到 0 或 NaN 而整個錯亂（例如所有後續文字疊在同一點）。
    if (!Number.isFinite(width) || width <= 0) {
      width = fontSize * 0.6;
    }
  }

  return width;
}

function wrapTokensIntoLines(font, fontSize, tokens, maxWidth) {
  const lines = [];
  let currentLine = [];
  let currentWidth = 0;

  for (const token of tokens) {
    if (currentLine.length === 0 && token.text.trim() === '') continue;

    const tokenWidth = measureTokenWidth(font, token, fontSize);

    if (currentWidth + tokenWidth > maxWidth && currentLine.length > 0) {
      lines.push(currentLine);
      if (token.text.trim() === '') {
        currentLine = [];
        currentWidth = 0;
      } else {
        currentLine = [token];
        currentWidth = tokenWidth;
      }
    } else {
      currentLine.push(token);
      currentWidth += tokenWidth;
    }
  }

  if (currentLine.length > 0) lines.push(currentLine);
  return lines.length > 0 ? lines : [[]];
}

/**
 * PdfLayoutEngine
 * -------------------------------------------------------------------------
 * 把「畫一行、換頁判斷、游標位置」這些狀態封裝成一個小物件，讓下面
 * 依區塊類型畫東西的程式碼不需要每個函式都手動傳一大堆參數。
 * -------------------------------------------------------------------------
 */
function createLayoutEngine(pdfDoc, font, PAGE_WIDTH, PAGE_HEIGHT, MARGIN, rgb) {
  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let cursorY = PAGE_HEIGHT - MARGIN;
  const usableWidth = PAGE_WIDTH - MARGIN * 2;
  // faux bold 的水平疊印位移量：太小看不出粗細差異，太大會讓字糊在一起，
  // 0.3pt 是實測後視覺上還算自然的折衷值。
  const BOLD_OFFSET = 0.3;

  function ensureSpace(neededHeight) {
    if (cursorY - neededHeight < MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      cursorY = PAGE_HEIGHT - MARGIN;
    }
  }

  function drawLine(line, x, y, fontSize, color) {
    let cursorX = x;
    for (const token of line) {
      if (token.bold) {
        page.drawText(token.text, { x: cursorX, y, size: fontSize, font, color });
        page.drawText(token.text, { x: cursorX + BOLD_OFFSET, y, size: fontSize, font, color });
      } else {
        page.drawText(token.text, { x: cursorX, y, size: fontSize, font, color });
      }
      cursorX += measureTokenWidth(font, token, fontSize);
    }
  }

  /** 畫一段「帶樣式的段落」，indent 是額外的左邊縮排（給清單項目用）。 */
  function drawParagraphBlock(tokens, fontSize, lineHeight, indent = 0, color = rgb(0, 0, 0)) {
    const lines = wrapTokensIntoLines(font, fontSize, tokens, usableWidth - indent);
    for (const line of lines) {
      ensureSpace(lineHeight);
      drawLine(line, MARGIN + indent, cursorY, fontSize, color);
      cursorY -= lineHeight;
    }
  }

  /** 畫程式碼區塊：先畫灰底矩形，再把文字疊上去，等寬字型不可得的折衷方案。 */
  function drawCodeBlock(text, fontSize, lineHeight) {
    const codeLines = text.split('\n');
    const tokensPerLine = codeLines.map((lineText) =>
      tokenizeRuns([{ text: lineText || ' ', bold: false, italic: false }])
    );
    // 先攤平計算總共會佔用幾行（含自動換行），才能預先畫出正確高度的
    // 背景矩形；wrapTokensIntoLines 對每一行程式碼分別呼叫，若程式碼
    // 單行過長仍會自動換行，只是會犧牲原始的等寬對齊視覺效果。
    const wrappedGroups = tokensPerLine.map((tokens) =>
      wrapTokensIntoLines(font, fontSize, tokens, usableWidth - 16)
    );
    const totalLines = wrappedGroups.reduce((sum, g) => sum + g.length, 0);
    const blockHeight = totalLines * lineHeight + 12;

    ensureSpace(blockHeight);
    page.drawRectangle({
      x: MARGIN - 4,
      y: cursorY - blockHeight + lineHeight - 2,
      width: usableWidth + 8,
      height: blockHeight,
      color: rgb(0.94, 0.94, 0.94),
    });

    cursorY -= 6;
    for (const group of wrappedGroups) {
      for (const line of group) {
        ensureSpace(lineHeight);
        drawLine(line, MARGIN + 4, cursorY, fontSize, rgb(0.2, 0.2, 0.2));
        cursorY -= lineHeight;
      }
    }
    cursorY -= 6;
  }

  return { drawParagraphBlock, drawCodeBlock, ensureSpace, moveCursor: (dy) => (cursorY += dy) };
}

/**
 * runWordToPdfConversion(taskId, file, fontBlob)
 * -------------------------------------------------------------------------
 * mammoth.js 轉出保留基本結構的 HTML → 解析成區塊清單 → 依序畫進
 * pdf-lib 文件，不同區塊類型套用不同的字級/縮排/背景樣式。
 * -------------------------------------------------------------------------
 */
async function runWordToPdfConversion(taskId, file, fontBlob) {
  postToMain('progress', { taskId, percent: 8, label: '正在載入 Word 解析引擎...' });
  await loadUmdScript(MAMMOTH_CDN_URL);

  postToMain('progress', { taskId, percent: 20, label: '正在解析 Word 文件內容...' });
  const wordArrayBuffer = await file.arrayBuffer();

  // styleMap：比對常見的「程式碼」段落樣式名稱，映射成 <pre> 標籤，
  // 讓後續的 parseHtmlIntoBlocks() 能辨識出程式碼區塊。若原始文件用的
  // 是完全不同的自訂樣式名稱，這裡比對不到，該段落會維持一般 <p>，
  // 文字內容依然正確保留，只是少了程式碼區塊的底色與等寬排版效果。
  const styleMap = [
    "p[style-name='Code'] => pre:fresh",
    "p[style-name='Source Code'] => pre:fresh",
    "p[style-name='HTML Preformatted'] => pre:fresh",
    "p[style-name='CodeBlock'] => pre:fresh",
    "p[style-name='程式碼'] => pre:fresh",
  ];

  const convertResult = await self.mammoth.convertToHtml({ arrayBuffer: wordArrayBuffer }, { styleMap });
  const htmlString = convertResult.value || '';

  if (convertResult.messages && convertResult.messages.length > 0) {
    console.warn('[pdf-worker] mammoth 解析警告：', convertResult.messages);
  }

  const blocks = parseHtmlIntoBlocks(htmlString);

  postToMain('progress', { taskId, percent: 35, label: '正在載入 PDF 產生引擎...' });
  await loadUmdScript(PDF_LIB_CDN_URL);
  await loadUmdScript(FONTKIT_CDN_URL);

  const { PDFDocument, StandardFonts, rgb } = self.PDFLib;
  const fontkit = self.fontkit;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  postToMain('progress', { taskId, percent: 55, label: '正在準備字型...' });

  let embeddedFont = null;
  let usingFallbackFont = false;

  if (fontBlob) {
    try {
      const fontBytes = new Uint8Array(await fontBlob.arrayBuffer());
      // ⚠️ 關鍵修正 ⚠️ 這裡「不可以」傳 { subset: true }。
      // 實測發現 pdf-lib（底層用 @pdf-lib/fontkit 做子集化）對這個
      // 中文字型檔案的複合字符（composite glyph，中文字形大量透過
      // 「引用其他字形部件組合而成」的方式儲存）子集化邏輯有 bug：
      // 子集化後大量常用字（例如「測」「試」「中」「文」等）會直接
      // 消失、無法繪製，但不會拋出任何錯誤，是一種「靜默遺字」的
      // 嚴重問題，非常隱蔽，肉眼從程式碼完全看不出來，只有實際產出
      // PDF 並打開來看才會發現。
      // 因此改為 { subset: false }，直接內嵌整份字型檔案 —— 這也是為
      // 什麼 assets/fonts/NotoSansTC-Regular.ttf 在部署前，必須先用
      // fonttools 預先裁切到常用字範圍（Basic Latin + 標點 + 全形符號
      // + CJK Unified Ideographs），把「子集化」這件事在建置階段做好，
      // 而不是依賴 pdf-lib 在執行階段做（執行階段做不出正確結果）。
      embeddedFont = await pdfDoc.embedFont(fontBytes, { subset: false });
    } catch (err) {
      console.warn('[pdf-worker] 中文字型內嵌失敗，改用標準字型（中文將以問號代替）：', err);
    }
  }

  if (!embeddedFont) {
    postToMain('progress', {
      taskId,
      percent: 60,
      label: fontBlob ? '字型無法使用，改用標準字型繼續轉檔...' : '未取得中文字型，使用標準字型...',
    });
    embeddedFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    usingFallbackFont = true;
  }

  // 若降級為標準字型，所有區塊的文字都要先過濾掉無法編碼的字元，
  // 這裡在「解析出來的區塊」上直接處理，比在排版階段逐一處理更集中。
  if (usingFallbackFont) {
    for (const block of blocks) {
      if (block.type === 'code') {
        block.text = sanitizeForStandardFont(block.text);
      } else if (block.runs) {
        block.runs = block.runs.map((r) => ({ ...r, text: sanitizeForStandardFont(r.text) }));
      }
    }
  }

  postToMain('progress', { taskId, percent: 70, label: '正在編排 PDF 版面...' });

  const PAGE_WIDTH = 595.28;
  const PAGE_HEIGHT = 841.89;
  const MARGIN = 42;
  const BASE_FONT_SIZE = 12;
  const BASE_LINE_HEIGHT = BASE_FONT_SIZE * 1.4;

  const engine = createLayoutEngine(pdfDoc, embeddedFont, PAGE_WIDTH, PAGE_HEIGHT, MARGIN, rgb);

  if (blocks.length === 0) {
    engine.drawParagraphBlock(
      tokenizeRuns([{ text: '（此文件沒有可擷取的文字內容）', bold: false, italic: false }]),
      BASE_FONT_SIZE,
      BASE_LINE_HEIGHT
    );
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      // 標題字級隨層級遞減（H1 最大），且一律用粗體呈現；標題上下都
      // 留額外間距，跟一般段落做出視覺區隔。
      const headingSize = Math.max(BASE_FONT_SIZE, 20 - (block.level - 1) * 2);
      const headingLineHeight = headingSize * 1.3;
      const boldTokens = tokenizeRuns(block.runs).map((t) => ({ ...t, bold: true }));
      engine.moveCursor(-headingLineHeight * 0.3);
      engine.drawParagraphBlock(boldTokens, headingSize, headingLineHeight);
      engine.moveCursor(-headingLineHeight * 0.2);
    } else if (block.type === 'paragraph') {
      engine.drawParagraphBlock(tokenizeRuns(block.runs), BASE_FONT_SIZE, BASE_LINE_HEIGHT);
      engine.moveCursor(-BASE_LINE_HEIGHT * 0.4); // 段落間距
    } else if (block.type === 'listItem') {
      const prefix = block.ordered ? `${block.index}. ` : '•  ';
      const tokens = [{ text: prefix, bold: false, italic: false }, ...tokenizeRuns(block.runs)];
      engine.drawParagraphBlock(tokens, BASE_FONT_SIZE, BASE_LINE_HEIGHT, 14);
    } else if (block.type === 'code') {
      engine.drawCodeBlock(block.text, BASE_FONT_SIZE * 0.92, BASE_LINE_HEIGHT * 0.9);
      engine.moveCursor(-BASE_LINE_HEIGHT * 0.3);
    }
  }

  postToMain('progress', { taskId, percent: 92, label: '正在輸出 PDF 檔案...' });

  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });

  postToMain('progress', { taskId, percent: 100, label: '轉檔完成' });
  postToMain('result', {
    taskId,
    blob,
    fileName: buildOutputFileName(file.name),
    fileSizeBytes: blob.size,
  });
}

self.onmessage = async (event) => {
  const { type, payload } = event.data || {};

  if (type === 'start') {
    const { taskId, file, options, fontBlob } = payload;
    const direction = (options && options.direction) || 'word-to-pdf';

    if (direction !== 'word-to-pdf') {
      postToMain('error', {
        taskId,
        message: `此 Worker 僅處理 'word-to-pdf'，收到不支援的方向：${direction}`,
      });
      return;
    }

    try {
      await runWordToPdfConversion(taskId, file, fontBlob || null);
    } catch (err) {
      console.error('[pdf-worker] 轉檔失敗：', err);
      postToMain('error', {
        taskId,
        message: err && err.message ? err.message : '文件轉檔過程發生未預期的錯誤。',
      });
    }
    return;
  }

  console.warn('[pdf-worker] 收到未處理的訊息類型：', type);
};
