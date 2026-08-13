/**
 * =============================================================================
 * ai-provider-detect.js
 * =============================================================================
 * 依 API Key 的字首格式，自動判斷這把金鑰屬於哪個 AI 供應商，讓使用者
 * 不需要自己手動切換下拉選單——貼上金鑰就好，選錯供應商送出去對方
 * 端點只會得到 400 Bad Request（就是我們實測遇到的狀況：把 OpenAI 的
 * "sk-proj-..." 金鑰送去 Gemini 的端點）。
 *
 * 依官方文件已知的格式規則：
 *   - Google Gemini（Google AI Studio 簽發）：一律以 "AIza" 開頭。
 *   - OpenAI：以 "sk-" 開頭（新式帳戶常見 "sk-proj-" 前綴，舊式帳戶
 *     則單純 "sk-" 開頭，這裡統一用 "sk-" 判斷即可涵蓋兩種情形）。
 * =============================================================================
 */

export function detectProviderFromKey(rawKey) {
  const key = (rawKey || '').trim();
  if (!key) return null;
  if (key.startsWith('AIza')) return 'gemini';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}
