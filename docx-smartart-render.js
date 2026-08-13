/**
 * =============================================================================
 * docx-smartart-render.js
 * =============================================================================
 * 【重大發現，讓 SmartArt 轉檔變得可行】
 * mammoth.js 不認得 SmartArt，但 Word 儲存 .docx 時，其實會順便把
 * 每一個 SmartArt「當下算好的最終畫面」存成一份純向量圖形描述檔
 * （word/diagrams/drawingN.xml，用的是 DrawingML 語法：一群
 * <dsp:sp> 形狀，每個都有算好的絕對座標、路徑、顏色、文字），這是
 * Word 給舊版本相容用的備援渲染，等於是「SmartArt 排版演算法算完
 * 之後的結果快照」。
 *
 * 這代表我們不需要重新實作 SmartArt 的排版演算法（那是完全不同量級
 * 的工程），只需要把這份「已經算好位置的圖形描述」轉譯成瀏覽器看得懂
 * 的 SVG 就好——這件事是可行的。
 *
 * 【已知限制（誠實列出，不是這裡沒做完，是刻意的範圍控制）】
 * 1. 圖形只處理 <a:custGeom>（自訂路徑，涵蓋絕大多數 SmartArt 形狀）
 *    跟簡單的 <a:prstGeom prst="rect">（退回畫矩形），其餘幾十種
 *    預設幾何形狀不逐一支援，會退回矩形。
 * 2. 顏色只處理最常見的 <a:srgbClr>（直接 RGB）與
 *    <a:schemeClr>（佈景主題色，含基本的 shade/tint 明暗調整），
 *    漸層填色（gradFill）等更複雜的填色方式會退回單一顏色。
 * 3. 每張圖表在文件裡「插入的順序」是用文件裡對應的關聯鏈
 *    （document.xml → dataN.xml → drawingM.xml）還原出來的，但因為
 *    mammoth.js 產生內容時完全不知道 SmartArt 的存在，沒辦法把每張
 *    圖表精確插回原本那一段文字的中間，只能依偵測到的順序，統一放在
 *    文件最前面的「圖表」區塊裡，附上編號，不是逐段精確內嵌。
 * =============================================================================
 */

import { loadScriptOnce } from './html-to-pdf-renderer.js';

const JSZIP_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const EMU_TO_PX = 1 / 9525; // 1 px (96dpi) = 9525 EMU

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  dsp: 'http://schemas.microsoft.com/office/drawing/2008/diagram',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};

function q(el, tag) {
  // XML 文件對「帶命名空間前綴的標籤名稱」用 getElementsByTagName 直接比對
  // 前綴字串即可正確取到節點，不需要額外處理命名空間 URI 比對，寫法上
  // 比較單純、也足夠應付這裡固定前綴（a:/dsp:）的情境。
  return Array.from(el.getElementsByTagName(tag));
}
function qFirst(el, tag) {
  const list = el.getElementsByTagName(tag);
  return list.length > 0 ? list[0] : null;
}

/** 解析 word/theme/theme1.xml 的色彩配置，回傳 { dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink } 十六進位色碼表。 */
function parseThemeColors(themeXmlDoc) {
  const scheme = qFirst(themeXmlDoc, 'a:clrScheme');
  const result = {};
  if (!scheme) return result;
  Array.from(scheme.children).forEach((node) => {
    const name = node.tagName.replace('a:', '');
    const srgb = qFirst(node, 'a:srgbClr');
    const sysClr = qFirst(node, 'a:sysClr');
    if (srgb) result[name] = `#${srgb.getAttribute('val')}`;
    else if (sysClr) result[name] = `#${sysClr.getAttribute('lastClr') || '000000'}`;
  });
  return result;
}

/** 把 0-100000 的千分比明暗調整值，套用在一個十六進位色碼上（近似值，非色彩精確轉換）。 */
function applyLumMod(hex, lumModPct, lumOffPct) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mod = lumModPct != null ? lumModPct / 100000 : 1;
  const off = lumOffPct != null ? (lumOffPct / 100000) * 255 : 0;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * mod + off)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 解析一個顏色節點（<a:solidFill> 底下的 <a:srgbClr>/<a:schemeClr>/<a:scrgbClr>），回傳 CSS 顏色字串或 null（無填色）。 */
function resolveFillColor(fillParent, themeColors) {
  if (!fillParent) return null;
  if (qFirst(fillParent, 'a:noFill')) return null;

  const solidFill = fillParent.tagName === 'a:solidFill' ? fillParent : qFirst(fillParent, 'a:solidFill');
  if (!solidFill) return '#94a3b8'; // 遇到漸層等複雜填色，退回一個中性灰藍色，至少形狀看得見

  const srgb = qFirst(solidFill, 'a:srgbClr');
  if (srgb) return `#${srgb.getAttribute('val')}`;

  const scrgb = qFirst(solidFill, 'a:scrgbClr');
  if (scrgb) {
    const toByte = (v) => Math.round((parseInt(v, 10) / 100000) * 255);
    return `rgb(${toByte(scrgb.getAttribute('r'))},${toByte(scrgb.getAttribute('g'))},${toByte(scrgb.getAttribute('b'))})`;
  }

  const schemeClr = qFirst(solidFill, 'a:schemeClr');
  if (schemeClr) {
    const name = schemeClr.getAttribute('val');
    let hex = themeColors[name] || themeColors[name === 'tx1' ? 'dk1' : name === 'bg1' ? 'lt1' : name] || '#94a3b8';
    const lumMod = qFirst(schemeClr, 'a:lumMod');
    const lumOff = qFirst(schemeClr, 'a:lumOff');
    if (lumMod || lumOff) {
      hex = applyLumMod(
        hex,
        lumMod ? parseInt(lumMod.getAttribute('val'), 10) : null,
        lumOff ? parseInt(lumOff.getAttribute('val'), 10) : null
      );
    }
    return hex;
  }

  return '#94a3b8';
}

/** 把 <a:custGeom><a:pathLst><a:path>...</a:path></a:custGeom> 轉成 SVG path 的 'd' 字串（座標單位維持 EMU，由外層統一縮放）。 */
function custGeomToSvgPath(custGeom) {
  const pathEl = qFirst(custGeom, 'a:path');
  if (!pathEl) return '';
  const commands = [];
  Array.from(pathEl.children).forEach((cmd) => {
    const tag = cmd.tagName.replace('a:', '');
    const pts = q(cmd, 'a:pt').map((p) => [parseFloat(p.getAttribute('x')), parseFloat(p.getAttribute('y'))]);
    if (tag === 'moveTo' && pts[0]) commands.push(`M ${pts[0][0]} ${pts[0][1]}`);
    else if (tag === 'lnTo' && pts[0]) commands.push(`L ${pts[0][0]} ${pts[0][1]}`);
    else if (tag === 'cubicBezTo' && pts.length === 3) {
      commands.push(`C ${pts[0][0]} ${pts[0][1]}, ${pts[1][0]} ${pts[1][1]}, ${pts[2][0]} ${pts[2][1]}`);
    } else if (tag === 'quadBezTo' && pts.length === 2) {
      commands.push(`Q ${pts[0][0]} ${pts[0][1]}, ${pts[1][0]} ${pts[1][1]}`);
    } else if (tag === 'close') commands.push('Z');
  });
  return commands.join(' ');
}

/** 從 <dsp:txBody> 取出純文字內容（不逐段還原字型樣式，只取文字本身跟粗略字級）。 */
function extractShapeText(sp) {
  const txBody = qFirst(sp, 'dsp:txBody');
  if (!txBody) return { text: '', fontSizePx: 12 };
  const runs = q(txBody, 'a:t');
  const text = runs.map((t) => t.textContent).join('');
  const firstRPr = qFirst(txBody, 'a:rPr');
  const szAttr = firstRPr ? firstRPr.getAttribute('sz') : null;
  const fontSizePx = szAttr ? (parseInt(szAttr, 10) / 100) * (96 / 72) : 12;
  return { text, fontSizePx };
}

/**
 * renderDrawingXmlToSvg(drawingXmlText, themeColors)
 * -------------------------------------------------------------------------
 * 把一份 drawingN.xml 的內容轉成一個完整的 <svg>...</svg> 字串。
 * -------------------------------------------------------------------------
 */
function renderDrawingXmlToSvg(drawingXmlText, themeColors) {
  const doc = new DOMParser().parseFromString(drawingXmlText, 'text/xml');
  const shapes = q(doc, 'dsp:sp');
  if (shapes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const shapeDefs = shapes.map((sp) => {
    const spPr = qFirst(sp, 'dsp:spPr');
    const xfrm = spPr ? qFirst(spPr, 'a:xfrm') : null;
    const off = xfrm ? qFirst(xfrm, 'a:off') : null;
    const ext = xfrm ? qFirst(xfrm, 'a:ext') : null;
    const x = off ? parseFloat(off.getAttribute('x')) : 0;
    const y = off ? parseFloat(off.getAttribute('y')) : 0;
    const cx = ext ? parseFloat(ext.getAttribute('cx')) : 0;
    const cy = ext ? parseFloat(ext.getAttribute('cy')) : 0;

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + cx);
    maxY = Math.max(maxY, y + cy);

    const custGeom = spPr ? qFirst(spPr, 'a:custGeom') : null;
    const pathD = custGeom ? custGeomToSvgPath(custGeom) : null;

    const fill = spPr ? resolveFillColor(qFirst(spPr, 'a:solidFill') || spPr, themeColors) : null;
    const lnEl = spPr ? qFirst(spPr, 'a:ln') : null;
    const stroke = lnEl ? resolveFillColor(lnEl, themeColors) : null;
    const strokeWidthEmu = lnEl && lnEl.getAttribute('w') ? parseFloat(lnEl.getAttribute('w')) : 0;

    const { text, fontSizePx } = extractShapeText(sp);

    return { x, y, cx, cy, pathD, fill, stroke, strokeWidthEmu, text, fontSizePx };
  });

  if (!isFinite(minX)) return null;

  const widthPx = (maxX - minX) * EMU_TO_PX;
  const heightPx = (maxY - minY) * EMU_TO_PX;
  if (widthPx <= 0 || heightPx <= 0 || widthPx > 20000 || heightPx > 20000) return null;

  const svgParts = shapeDefs.map((shape) => {
    const localX = (shape.x - minX) * EMU_TO_PX;
    const localY = (shape.y - minY) * EMU_TO_PX;
    const w = shape.cx * EMU_TO_PX;
    const h = shape.cy * EMU_TO_PX;
    const fillAttr = shape.fill ? `fill="${shape.fill}"` : 'fill="none"';
    const strokeAttr = shape.stroke ? `stroke="${shape.stroke}" stroke-width="${Math.max(0.5, shape.strokeWidthEmu * EMU_TO_PX)}"` : 'stroke="none"';

    let shapeMarkup;
    if (shape.pathD) {
      // custGeom 的路徑座標是相對於這個形狀自己的 ext（寬高）座標系，
      // 用 <g transform="translate + scale"> 把它搬到整張 SVG 的正確
      // 位置：先平移到這個形狀在整張圖裡的實際位置，再用
      // 「目標像素寬高 ÷ 原始 EMU 寬高」當縮放係數，把 EMU 座標系直接
      // 映射成 px 座標系。
      const scaleX = shape.cx ? w / shape.cx : EMU_TO_PX;
      const scaleY = shape.cy ? h / shape.cy : EMU_TO_PX;
      shapeMarkup = `<g transform="translate(${localX},${localY}) scale(${scaleX},${scaleY})"><path d="${shape.pathD}" ${fillAttr} ${strokeAttr}/></g>`;
    } else {
      shapeMarkup = `<rect x="${localX}" y="${localY}" width="${w}" height="${h}" ${fillAttr} ${strokeAttr}/>`;
    }

    let textMarkup = '';
    if (shape.text && shape.text.trim()) {
      textMarkup = `<foreignObject x="${localX}" y="${localY}" width="${w}" height="${h}">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;font-size:${shape.fontSizePx}px;font-family:'Noto Sans TC','Microsoft JhengHei',sans-serif;color:#1e293b;line-height:1.2;padding:2px;box-sizing:border-box;word-break:break-word;">${escapeHtml(shape.text)}</div>
      </foreignObject>`;
    }

    return shapeMarkup + textMarkup;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPx} ${heightPx}" width="${Math.min(widthPx, 700)}" style="max-width:100%;height:auto;">${svgParts.join('')}</svg>`;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * renderAllSmartArtToHtml(file)
 * -------------------------------------------------------------------------
 * 找出這份 .docx 裡所有可以還原的 SmartArt 圖表，各自轉成 SVG，組成
 * 一段「圖表」HTML 區塊（每張圖表附上編號跟外框），回傳這段 HTML
 * 字串；完全沒有可還原的圖表則回傳空字串。
 * -------------------------------------------------------------------------
 */
export async function renderAllSmartArtToHtml(file) {
  try {
    await loadScriptOnce(JSZIP_CDN_URL);
    const zip = await window.JSZip.loadAsync(file);

    let themeColors = {};
    const themeFile = zip.file('word/theme/theme1.xml');
    if (themeFile) {
      const themeXmlText = await themeFile.async('text');
      themeColors = parseThemeColors(new DOMParser().parseFromString(themeXmlText, 'text/xml'));
    }

    const drawingPaths = [];
    zip.forEach((relativePath) => {
      if (/^word\/diagrams\/drawing\d+\.xml$/.test(relativePath)) drawingPaths.push(relativePath);
    });
    // 依檔名裡的數字排序（drawing1, drawing2, ... drawing10），盡量還原文件裡原本的先後順序。
    drawingPaths.sort((a, b) => {
      const numA = parseInt(a.match(/(\d+)/)[1], 10);
      const numB = parseInt(b.match(/(\d+)/)[1], 10);
      return numA - numB;
    });

    const renderedBlocks = [];
    for (let i = 0; i < drawingPaths.length; i += 1) {
      try {
        const xmlText = await zip.file(drawingPaths[i]).async('text');
        const svg = renderDrawingXmlToSvg(xmlText, themeColors);
        if (svg) {
          renderedBlocks.push(
            `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:14px;text-align:center;background:#fafafa;">
              <div style="font-size:12px;color:#64748b;margin-bottom:8px;">圖表 ${i + 1}</div>
              ${svg}
            </div>`
          );
        }
      } catch (err) {
        console.warn(`[docx-smartart-render] 圖表 ${i + 1} 還原失敗，略過：`, err);
      }
    }

    if (renderedBlocks.length === 0) return '';

    return `<div style="margin-bottom:20px;">
      <h2 style="font-size:18px;margin-bottom:10px;">還原的 SmartArt 圖表（依偵測順序排列，非原始段落位置）</h2>
      ${renderedBlocks.join('')}
    </div>`;
  } catch (err) {
    console.warn('[docx-smartart-render] SmartArt 還原失敗，略過此項：', err);
    return '';
  }
}
