/**
 * =============================================================================
 * ai-key-manager.js
 * =============================================================================
 * 【模組定位】
 * BYOK（Bring Your Own Key）金鑰的唯一存取入口。
 *
 * 隱私規則（不可違反）：
 *   1. API Key 只能寫入 localStorage，絕對不能出現在任何對外送出的
 *      HTTP 請求 header/body 裡「除了」使用者自己指定的 AI 供應商端點
 *      （Gemini / OpenAI 官方 API）本身——也就是說，金鑰只會流向
 *      使用者自己填入的那一個第三方 API，不會流向本專案的任何後端
 *      （因為本專案根本沒有後端），也不會被夾帶進任何其他請求。
 *   2. 本模組不主動上傳、不記錄 log、不呼叫任何 analytics。
 *
 * 【與 UI 的溝通方式】
 * 沿用既有架構：UI 端一律透過 EventBus 送出「儲存 / 清除 / 查詢」意圖，
 * 不直接 import 本模組。本模組把 localStorage 讀寫這件事，視同
 * font-cache-manager.js 對 IndexedDB 的讀寫——都是「瀏覽器儲存 API」，
 * 不是 DOM 操作，因此放在 core 層是合理的，且與現有慣例一致。
 * =============================================================================
 */

import { EventBus_instance } from './event-bus.js';
import { getLocalConfig } from './local-config-loader.js';

const STORAGE_PREFIX = 'converter-tool:ai-key:';

export const AI_KEY_EVENTS = {
  // UI → core
  SAVE: 'converter:ai-settings-save',       // { provider, apiKey, remember }
  CLEAR: 'converter:ai-settings-clear',     // { provider }
  REQUEST: 'converter:ai-settings-request', // {}（頁面載入時查詢目前已儲存的狀態）
  // core → UI
  STATUS: 'converter:ai-settings-status',   // { provider, apiKey, hasKey }
};

function storageKey(provider) {
  return `${STORAGE_PREFIX}${provider}`;
}

/**
 * getStoredKey(provider)
 * -------------------------------------------------------------------------
 * 供 AiDocumentConverter（同屬 core 層）直接 import 呼叫，
 * 取得「使用者勾選記住」時所儲存的金鑰；若使用者當次沒有勾選記住，
 * AiDocumentConverter 會改用 options.apiKey（UI 表單即時讀到的值），
 * 兩者擇一，並非互斥設計上的衝突。
 * -------------------------------------------------------------------------
 */
export function getStoredKey(provider) {
  try {
    return localStorage.getItem(storageKey(provider)) || '';
  } catch (err) {
    console.warn('[AiKeyManager] 無法讀取 localStorage：', err);
    return '';
  }
}

function setStoredKey(provider, apiKey) {
  try {
    localStorage.setItem(storageKey(provider), apiKey);
  } catch (err) {
    // 極少數情境（例如無痕模式下部分瀏覽器封鎖 localStorage 寫入、
    // 或儲存空間已滿）寫入會失敗，這裡不拋出例外中斷流程，僅記錄，
    // 讓使用者仍可在「不記住」的情況下完成這一次的 AI 處理。
    console.warn('[AiKeyManager] 無法寫入 localStorage：', err);
  }
}

function clearStoredKey(provider) {
  try {
    localStorage.removeItem(storageKey(provider));
  } catch (err) {
    console.warn('[AiKeyManager] 無法清除 localStorage：', err);
  }
}

function emitStatus(provider) {
  const apiKey = getStoredKey(provider);
  EventBus_instance.emit(AI_KEY_EVENTS.STATUS, {
    provider,
    apiKey,
    hasKey: apiKey.length > 0,
  });
}

let isInitialized = false;

export function initAiKeyManager() {
  if (isInitialized) return;
  isInitialized = true;

  // 用 config.local.js（如果使用者有建立的話）裡的預設值「種」進
  // localStorage，只在該供應商目前完全沒有已儲存金鑰時才套用，避免
  // 蓋掉使用者之後自己在畫面上改過、清除過的設定。詳見
  // local-config-loader.js 檔頭的安全性說明。
  const localConfig = getLocalConfig();
  if (localConfig.geminiApiKey && !getStoredKey('gemini')) {
    setStoredKey('gemini', localConfig.geminiApiKey);
  }
  if (localConfig.openaiApiKey && !getStoredKey('openai')) {
    setStoredKey('openai', localConfig.openaiApiKey);
  }

  EventBus_instance.on(AI_KEY_EVENTS.SAVE, ({ provider, apiKey, remember }) => {
    if (remember) {
      setStoredKey(provider, apiKey || '');
    } else {
      // 使用者取消勾選「記住金鑰」時儲存，視同要求清除舊有紀錄，
      // 避免「這次沒勾選記住，但上次勾選過的舊金鑰」繼續殘留在
      // localStorage 裡造成使用者誤解「已清除」的期待落差。
      clearStoredKey(provider);
    }
    emitStatus(provider);
  });

  EventBus_instance.on(AI_KEY_EVENTS.CLEAR, ({ provider }) => {
    clearStoredKey(provider);
    emitStatus(provider);
  });

  EventBus_instance.on(AI_KEY_EVENTS.REQUEST, ({ provider }) => {
    emitStatus(provider);
  });

  console.info('[AiKeyManager] 初始化完成。');
}
