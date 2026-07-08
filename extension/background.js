const DEFAULT_SETTINGS = {
  providerMode: "direct",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  apiMode: "responses",
  modelPreset: "gpt-5.5",
  model: "gpt-5.5",
  reasoningEffort: "low",
  textVerbosity: "low",
  endpoint: "http://127.0.0.1:8787",
  targetLanguage: "Simplified Chinese",
  sourceLanguage: "auto",
  mode: "replace",
};

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function publicSettings(settings) {
  const { apiKey, ...safeSettings } = settings;
  safeSettings.hasApiKey = Boolean(apiKey);
  return safeSettings;
}

async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
  return getSettings();
}

function normalizeApiUrl(baseUrl, apiPath) {
  const cleanBase = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!cleanBase) throw new Error("Base URL is required.");
  const basePath = new URL(`${cleanBase}/`).pathname.replace(/\/+$/, "");
  const normalizedPath =
    basePath.endsWith("/v1") && apiPath.startsWith("/v1/")
      ? apiPath.slice(3)
      : apiPath;
  return new URL(normalizedPath.replace(/^\/+/, ""), `${cleanBase}/`).toString();
}

function extractResponsesText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n");
}

function parseTranslations(raw, expectedLength) {
  let text = String(raw || "").trim();
  if (!text) {
    throw new Error(
      "API returned empty translation content. If you use an OpenAI-compatible gateway such as ColabAPI, choose 'Chat Completions compatible' in extension options.",
    );
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    text = text.slice(firstBracket, lastBracket + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const preview = text.slice(0, 180);
    throw new Error(
      `The model did not return a JSON translation array. Please check API mode and model. Response preview: ${preview}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("The model response was not a JSON array.");
  }

  const translations = parsed.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item.translation === "string") return item.translation;
    return "";
  });

  if (translations.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} translations, got ${translations.length}.`);
  }
  return translations;
}

function buildPrompt(payload, settings) {
  const cleanTexts = payload.texts.map((text) => String(text || "").trim());
  return [
    `Translate the following webpage text snippets into ${settings.targetLanguage || "Simplified Chinese"}.`,
    settings.sourceLanguage && settings.sourceLanguage !== "auto"
      ? `The source language is ${settings.sourceLanguage}.`
      : "Detect the source language automatically.",
    "Return ONLY a JSON array of strings, with exactly one translated string for each input string, in the same order.",
    "Preserve numbers, paper titles, method names, robotics terms, code identifiers, URLs, and inline punctuation where natural.",
    "Do not add explanations, markdown, indexes, or extra fields.",
    payload.pageTitle ? `Page title: ${payload.pageTitle}` : "",
    payload.pageUrl ? `Page URL: ${payload.pageUrl}` : "",
    "",
    JSON.stringify(cleanTexts),
  ]
    .filter(Boolean)
    .join("\n");
}

async function postJson(url, settings, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`API returned non-JSON response: ${raw.slice(0, 180)}`);
    }
  }
  if (!response.ok) {
    throw new Error(data.error?.message || `API request failed with HTTP ${response.status}.`);
  }
  if (!raw) {
    throw new Error("API returned an empty HTTP response. Check Base URL, API mode, and model name.");
  }
  return data;
}

async function translateDirect(payload, settings) {
  if (!settings.apiKey) {
    throw new Error("Please open extension options and set your API key first.");
  }
  if (!Array.isArray(payload.texts) || !payload.texts.length) {
    throw new Error("No text to translate.");
  }

  const prompt = buildPrompt(payload, settings);
  if (settings.apiMode === "chat") {
    const data = await postJson(normalizeApiUrl(settings.baseUrl, "/v1/chat/completions"), settings, {
      model: settings.model,
      messages: [
        {
          role: "system",
          content:
            "You are a precise academic webpage translation engine. Preserve terminology and concise UI text.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    });
    return {
      translations: parseTranslations(data.choices?.[0]?.message?.content || "", payload.texts.length),
      model: settings.model,
    };
  }

  const data = await postJson(normalizeApiUrl(settings.baseUrl, "/v1/responses"), settings, {
    model: settings.model,
    reasoning: { effort: settings.reasoningEffort || "low" },
    text: { verbosity: settings.textVerbosity || "low" },
    input: [
      {
        role: "system",
        content:
          "You are a precise academic webpage translation engine. Preserve terminology and concise UI text.",
      },
      { role: "user", content: prompt },
    ],
  });
  return {
    translations: parseTranslations(extractResponsesText(data), payload.texts.length),
    model: settings.model,
  };
}

async function translateBatch(payload) {
  const settings = await getSettings();
  if (settings.providerMode === "direct") {
    return translateDirect(payload, settings);
  }

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
  chrome.contextMenus.create({
    id: "open-settings",
    title: "打开翻译设置",
    contexts: ["action", "page"],
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
  if (info.menuItemId === "open-settings") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translator:get-settings") {
    getSettings().then((settings) => sendResponse(publicSettings(settings)));
    return true;
  }
  if (message?.type === "translator:get-private-settings") {
    getSettings().then(sendResponse);
    return true;
  }
  if (message?.type === "translator:save-settings") {
    saveSettings(message.patch || {}).then((settings) => sendResponse(publicSettings(settings)));
    return true;
  }
  if (message?.type === "translator:translate") {
    translateBatch(message)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "translator:test") {
    translateBatch({
      texts: ["Embodied intelligence enables robots to interact with the physical world."],
      pageTitle: "Connection test",
      pageUrl: "chrome-extension://options",
    })
      .then((data) => sendResponse({ ok: true, sample: data.translations?.[0] || "" }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "translator:open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
