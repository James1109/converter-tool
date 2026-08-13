/**
 * =============================================================================
 * github-settings-manager.js
 * =============================================================================
 * 「進階轉檔（GitHub Actions）」設定（帳號／repo／Token）的 localStorage
 * 儲存模組，架構上比照 ai-key-manager.js：UI 端只透過 EventBus 送出
 * 「儲存／查詢」意圖，實際的 localStorage 讀寫集中在這個 core 層模組。
 * =============================================================================
 */

import { EventBus_instance } from './event-bus.js';
import { getLocalConfig } from './local-config-loader.js';

const STORAGE_KEY = 'converter-tool:gh-actions-settings';

export const GH_SETTINGS_EVENTS = {
  SAVE: 'converter:gh-settings-save', // { owner, repo, token, remember }
  REQUEST: 'converter:gh-settings-request', // {}
  STATUS: 'converter:gh-settings-status', // { owner, repo, token, hasSettings }
};

function getStoredSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('[GithubSettingsManager] 無法讀取 localStorage：', err);
    return null;
  }
}

function setStoredSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('[GithubSettingsManager] 無法寫入 localStorage：', err);
  }
}

function clearStoredSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[GithubSettingsManager] 無法清除 localStorage：', err);
  }
}

function emitStatus() {
  const stored = getStoredSettings();
  EventBus_instance.emit(GH_SETTINGS_EVENTS.STATUS, {
    owner: stored?.owner || '',
    repo: stored?.repo || '',
    token: stored?.token || '',
    hasSettings: !!stored,
  });
}

let isInitialized = false;

export function initGithubSettingsManager() {
  if (isInitialized) return;
  isInitialized = true;

  // 同 ai-key-manager.js：用 config.local.js 裡的預設值種進
  // localStorage，只在目前完全沒有已儲存設定時才套用。
  const localConfig = getLocalConfig();
  if (!getStoredSettings() && (localConfig.githubOwner || localConfig.githubToken)) {
    setStoredSettings({
      owner: localConfig.githubOwner || '',
      repo: localConfig.githubRepo || '',
      token: localConfig.githubToken || '',
    });
  }

  EventBus_instance.on(GH_SETTINGS_EVENTS.SAVE, ({ owner, repo, token, remember }) => {
    if (remember) {
      setStoredSettings({ owner, repo, token });
    } else {
      clearStoredSettings();
    }
    emitStatus();
  });

  EventBus_instance.on(GH_SETTINGS_EVENTS.REQUEST, () => {
    emitStatus();
  });

  console.info('[GithubSettingsManager] 初始化完成。');
}
