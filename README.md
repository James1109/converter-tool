# 檔案轉檔與 AI 文件處理工具

100% 純前端、零伺服器成本的網頁轉檔工具，部署在 GitHub Pages。支援圖片格式互轉、PDF↔圖片、Word→PDF，並提供 BYOK（Bring Your Own Key）模式的 AI 輔助文件處理（Gemini / OpenAI）。

## 為什麼做這個專案

市面上的線上轉檔工具幾乎都要把檔案上傳到別人的伺服器，對於私密文件（履歷、合約、內部技術文件）是個隱私疑慮。這個專案的核心目標是：**檔案處理全程留在使用者自己的瀏覽器裡，不經過任何伺服器**，同時盡可能達到接近傳統轉檔工具的品質。

## 核心特色

- **圖片轉檔**：常見格式互轉，品質可調
- **PDF → 圖片**：PDF 逐頁轉成圖片，純前端（pdf.js）
- **AI 智慧文件處理**：BYOK 呼叫 Gemini / OpenAI，提供「完整忠實轉寫」「智慧整理與修飾」「自訂提示詞」三種模式，輸出 PDF 或可複製文字的 HTML
- **精準轉檔（GitHub Actions + LibreOffice）**：串接使用者自己 Fork 出去的 repo，用真正的 LibreOffice 排版引擎轉檔，支援 PDF / HTML / PNG / JPG，排版精確度與 SmartArt 支援度都優於純瀏覽器渲染，取代了原本的「標準 Word→PDF」路徑
- **影音轉檔**：FFmpeg.wasm，含裝置能力偵測（Safari/行動裝置的差異化限制）
- **零伺服器**：所有運算都在瀏覽器本機執行；AI 功能與精準轉檔功能的金鑰只存在 localStorage，直接呼叫官方端點，不經過本專案的任何後端（因為沒有後端）

## 技術架構

```
index.html                  UI 結構（Tailwind），不含任何業務邏輯
converter-core.js           啟動入口，初始化所有 core 模組
event-bus.js                UI 與 core 之間唯一的溝通管道（Pub/Sub）
converter-orchestrator.js   依 tool 名稱把請求路由到對應的 Converter
ui-bridge.js                UI 層：讀表單、更新畫面，不碰轉檔邏輯
worker-lifecycle.js         Web Worker / 主執行緒任務的生命週期管理
device-profiler.js          裝置能力偵測（觸控/螢幕尺寸/瀏覽器類型）
progress-guard.js           進度條防退演算法（避免進度百分比忽大忽小）

converters/
  ImageConverter.js          圖片轉檔
  PdfConverter.js             PDF↔圖片、Word→PDF（標準模式）
  AiDocumentConverter.js      Word→PDF/HTML（AI 模式，BYOK）
  VideoConverter.js           影音轉檔（FFmpeg.wasm）
  AudioConverter.js

mammoth-extract.js           共用的 docx→HTML 解析
html-to-pdf-renderer.js      共用的 HTML→PDF 渲染器（html2canvas + jsPDF 手動分頁）
docx-page-setup.js           讀取 docx 內部的頁面尺寸/邊界/字型設定
docx-content-audit.js        偵測 SmartArt 等無法轉換的內容，產生警告與文字附錄
ai-key-manager.js            BYOK 金鑰的 localStorage 存取
ai-provider-detect.js        依金鑰格式自動判斷 Gemini/OpenAI
```

**架構原則**：UI 與邏輯徹底分離。`ui-bridge.js` 只做「讀表單、寫畫面」，所有轉檔邏輯都在 `core` 層（converter-core.js 及其匯入的模組），兩者只透過 `EventBus` 溝通，不互相 import DOM 相關的東西。這讓每個 Converter 都可以獨立測試、替換，不會因為改 UI 排版而牽動轉檔邏輯。

## 開發過程中的關鍵技術難題

這個專案最有意思的部分，是排查一系列「看起來很像 bug，但其實是底層函式庫已知限制」的問題。記錄下來，也是這個專案在技術深度上比較有價值的地方：

### 1. pdf-lib 的連字（ligature）替換 vs. 手刻排版邏輯衝突

最初 Word→PDF 用 pdf-lib + fontkit 手動計算文字寬度與換行。實測發現只要文字裡出現 "fi"（例如 "Firebase"）這種有 GSUB 連字規則的字母組合，fontkit 會把它合併成一個連字字形，但手刻的換行邏輯是按「一個字元＝一份寬度」在算，兩者對不上，就會出現數字跟文字疊在一起、單字被拆散甚至變亂碼。

**解法**：放棄手動排版，改用 html2canvas 把瀏覽器實際渲染出來的畫面截圖存成 PDF——文字排版交給瀏覽器自己處理，不會有「自己算寬度算錯」的問題。代價是輸出文字不可反白選取。

### 2. html2canvas 對 `position: fixed` 元素的複製機制缺陷

為了讓渲染容器不被使用者看到，一開始把它放在 `position: fixed; left: -99999px`（螢幕外極遠處）。結果 html2canvas 複製 DOM 到內部 iframe 再測量時，量到的高度永遠是 0，輸出全白的 PDF。改成 `position: absolute` 也還是不穩定。最後放棄「隱藏」的思路，改成短暫真的顯示在畫面上（蓋一層遮罩擋住），這是 html2canvas 原本設計預期的使用情境，才徹底解決。

### 3. Gemini 2.5 Flash 的「思考」token 吃光輸出配額

AI 智慧處理長文件時，內容常常從中間斷掉。追查發現 gemini-2.5-flash 預設會開啟思考（thinking）機制，思考產生的 token 跟實際輸出共用同一包 `maxOutputTokens` 配額，預設只有 8192，長文件思考還沒結束配額就用完了。解法：依模式關閉/調整思考預算，並明確檢查 API 回應的 `finishReason`，一旦偵測到 `MAX_TOKENS` 就直接回報錯誤，不讓使用者拿到一份斷尾的結果卻不知情。

### 4. 分頁演算法：量測「脫離文件樹」的節點，高度永遠是 0

自製的多頁分頁邏輯，一度把要測量高度的節點搬到一個「從沒被加進畫面過」的容器裡才量——脫離渲染樹的 DOM 元素 `offsetHeight` 恆為 0，導致「這一組會不會超過一頁」的判斷式永遠不成立，所有內容擠成一頁。修正為「先在還連著畫面的狀態下量好高度、分好組，才把節點搬到各自的頁面容器」。

### 5. docx 內部隱藏的排版資訊：sectPr 與 theme 字型

mammoth.js 專注在語意化內容轉換，刻意不保留頁面尺寸/邊界/字型這類排版資訊。為了讓輸出更貼近 Word 原始版面，直接用 JSZip 打開 .docx（本質是 ZIP 檔），解析 `word/document.xml` 的 `<w:sectPr>`（頁面尺寸與邊界，單位是 twips）跟 `word/theme/theme1.xml` 的 `<a:minorFont>`（文件實際使用的西文/中文字型），套用到渲染器，讓分頁位置與字寬更接近原始 Word 文件。

### 6. SmartArt：不是圖片，是向量資料 + 排版演算法

使用者回報「圖不見了」，追查發現該 docx 完全沒有內嵌點陣圖，內含的 39 個「圖」全部是 SmartArt（`word/diagrams/data*.xml`），這是 mammoth.js（以及幾乎所有輕量前端函式庫）完全不支援的格式——要畫出來等於要重新實作 Word 的圖表排版演算法。務實解法：偵測 SmartArt 數量並在輸出內容加上明確警告，同時額外解析出圖表內的文字內容，整理成附錄段落，至少不讓資訊完全消失。

### 7. 純瀏覽器排版 vs. Word 排版引擎：技術天花板

多輪測試後確認：就算頁面尺寸、邊界、字型全部對齊 Word 原始設定，瀏覽器的文字排版引擎跟 Word 自己的排版引擎終究是兩套不同的軟體，斷行、字距的細節計算不會逐像素相同。這是純前端架構的技術天花板，不是參數沒調好——要做到真正逐頁一致，需要接入真正的 Office 相容排版引擎（例如透過 BYOK 呼叫 CloudConvert 之類的第三方轉檔 API，或自架 LibreOffice headless 服務），兩者都會打破「純前端零伺服器」的原始設定，是刻意保留、尚未實作的擴充方向。

## 已知限制

- Word→PDF（含 AI 模式）輸出的 PDF 是排版截圖，文字無法反白選取／複製（AI 模式可改選 HTML 輸出格式來取得可複製文字的版本）
- 不支援舊版 `.doc`（二進位格式），僅支援 `.docx`
- SmartArt 圖表無法還原圖形本身，僅能保留文字內容
- 分頁結果盡量貼近但無法保證與 Word 原始分頁逐頁一致
- 行動裝置封鎖影音轉檔功能（裝置效能限制）；AI 文件處理不受此限制

## 部署

純靜態網站，直接部署到 GitHub Pages 即可。`coi-serviceworker.js` 用於解決 FFmpeg.wasm 所需的跨域隔離（COOP/COEP），Service Worker 註冊路徑會依部署路徑動態計算，支援子路徑部署（例如 `username.github.io/repo-name/`）。
