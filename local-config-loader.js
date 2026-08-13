/**
 * =============================================================================
 * local-config-loader.js
 * =============================================================================
 * 【這個檔案在解決什麼問題】
 * 使用者每次開啟這個工具，都要重新（或每次瀏覽器清快取後重新）貼上
 * Gemini/OpenAI 金鑰、GitHub 帳號/repo/Token，很麻煩。這個模組讓
 * 使用者可以把這些設定集中寫在同一個檔案（config.local.js，不會被
 * commit 進 Git，見下方說明），開啟頁面時自動帶入，不用每次手動輸入。
 *
 * 【運作方式】
 * index.html 在載入任何模組之前，會先用一般 <script src="config.local.js">
 * 載入這個檔案（找不到檔案就靜靜失敗，不影響其他功能）。這個檔案裡
 * 只需要寫一行：
 *
 *   window.CONVERTER_TOOL_LOCAL_CONFIG = { geminiApiKey: 'xxx', ... };
 *
 * 本模組（local-config-loader.js）提供 getLocalConfig()，讓
 * ai-key-manager.js / github-settings-manager.js 在初始化時讀取這份
 * 設定，「種」進 localStorage 當作預設值（僅在該項目目前完全沒有
 * 已儲存值時才套用，不會覆蓋使用者之後自己在畫面上改過的設定）。
 *
 * 【⚠️ 安全性，這件事非常重要，請務必讀完】
 * 這個工具部署在 GitHub Pages 上，是一個公開的靜態網站——任何一個
 * 被 commit 進 Git repo、部署上去的檔案，全世界都看得到原始碼。
 * 所以：
 *   1. config.local.js 這個檔名已經被加進 .gitignore，Git 預設不會
 *      追蹤它、不會被 commit、不會出現在部署到 GitHub Pages 的版本裡。
 *   2. 你只需要在「自己電腦本機」建立這個檔案（複製
 *      config.local.example.js 改名並填入真實金鑰），檔案只會留在
 *      你自己的電腦上，供你本機開發/測試時使用。
 *   3. 千萬不要手動把 config.local.js 加回 Git 追蹤、或用
 *      `git add -f` 強制加入——這樣做金鑰就會被公開在網路上，任何人
 *      都能撿走去用，額度被盜刷的風險自負。
 *   4. 如果是要給「你自己以外的其他使用者」用的正式部署版本，不應該
 *      依賴這個檔案——應該讓每個使用者自己在畫面上輸入自己的金鑰
 *      （現有 UI 的 BYOK 輸入框本來就是為了這個情境設計的）。這個
 *      config.local.js 的機制，設計上就是給「只有你自己一個人用」
 *      的情境用的捷徑，不是給多人共用網站設計的。
 * =============================================================================
 */

export function getLocalConfig() {
  if (typeof window === 'undefined') return {};
  return window.CONVERTER_TOOL_LOCAL_CONFIG || {};
}
