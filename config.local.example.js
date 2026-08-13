/**
 * config.local.example.js
 * -----------------------------------------------------------------------
 * 使用方式：
 *   1. 複製這個檔案，改名成 config.local.js（跟這個範本放在同一層
 *      目錄，也就是 index.html 旁邊）
 *   2. 把下面的空字串換成你自己的真實金鑰/帳號
 *   3. config.local.js 已經被加進 .gitignore，不會被 commit、不會
 *      出現在部署到 GitHub Pages 的版本裡，只會留在你自己電腦本機。
 *      詳細安全性說明見 local-config-loader.js 檔頭。
 *
 * 每一項都是選填——只要填了，開啟頁面時就會自動帶入對應欄位；沒填的
 * 項目維持原本「使用者自己在畫面上輸入」的行為，不受影響。
 * -----------------------------------------------------------------------
 */
window.CONVERTER_TOOL_LOCAL_CONFIG = {
  // AI 文件處理（BYOK）—— 只需要填你實際會用的那一個供應商即可
  geminiApiKey: '',
  openaiApiKey: '',

  // 進階轉檔（GitHub Actions + LibreOffice）
  githubOwner: '',
  githubRepo: '',
  githubToken: '',
};
