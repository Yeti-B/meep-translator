const DEFAULT_SETTINGS = {
  endpoint: "http://127.0.0.1:8787",
  targetLanguage: "Simplified Chinese",
  sourceLanguage: "auto",
  mode: "replace",
};

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
  return getSettings();
}

async function translateBatch(payload) {
  const settings = await getSettings();
  const response = await fetch(`${settings.endpoint.replace(/\/+$/, "")}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      texts: payload.texts,
      targetLanguage: settings.targetLanguage,
      sourceLanguage: settings.sourceLanguage,
      pageTitle: payload.pageTitle,
      pageUrl: payload.pageUrl,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Proxy request failed with HTTP ${response.status}.`);
  }
  return data;
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, message).catch(async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      // Some pages, such as extension and browser pages, cannot be scripted.
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "translate-page",
    title: "用 OpenAI 翻译此页",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: "restore-page",
    title: "恢复原文",
    contexts: ["page"],
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "translator:toggle" }).catch(async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await chrome.tabs.sendMessage(tab.id, { type: "translator:toggle" });
    } catch {
      // Ignore pages Edge does not allow extensions to touch.
    }
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "translate-page") {
    sendToActiveTab({ type: "translator:start" });
  }
  if (info.menuItemId === "restore-page") {
    sendToActiveTab({ type: "translator:restore" });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translator:get-settings") {
    getSettings().then(sendResponse);
    return true;
  }
  if (message?.type === "translator:save-settings") {
    saveSettings(message.patch || {}).then(sendResponse);
    return true;
  }
  if (message?.type === "translator:translate") {
    translateBatch(message)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});
