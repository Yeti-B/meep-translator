const fields = {
  apiKey: document.querySelector("#apiKey"),
  baseUrl: document.querySelector("#baseUrl"),
  apiMode: document.querySelector("#apiMode"),
  model: document.querySelector("#model"),
  reasoningEffort: document.querySelector("#reasoningEffort"),
  textVerbosity: document.querySelector("#textVerbosity"),
  endpoint: document.querySelector("#endpoint"),
  targetLanguage: document.querySelector("#targetLanguage"),
  mode: document.querySelector("#mode"),
};

const directPanel = document.querySelector("#directPanel");
const proxyPanel = document.querySelector("#proxyPanel");
const statusEl = document.querySelector("#status");

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = type;
}

function providerMode() {
  return document.querySelector('input[name="providerMode"]:checked')?.value || "direct";
}

function setProviderMode(value) {
  const input = document.querySelector(`input[name="providerMode"][value="${value}"]`);
  if (input) input.checked = true;
  directPanel.hidden = value !== "direct";
  proxyPanel.hidden = value !== "proxy";
}

async function loadSettings() {
  const settings = await chrome.runtime.sendMessage({ type: "translator:get-settings" });
  setProviderMode(settings.providerMode || "direct");
  for (const [key, field] of Object.entries(fields)) {
    if (settings[key] !== undefined) field.value = settings[key];
  }
}

function readSettings() {
  return {
    providerMode: providerMode(),
    apiKey: fields.apiKey.value.trim(),
    baseUrl: fields.baseUrl.value.trim(),
    apiMode: fields.apiMode.value,
    model: fields.model.value.trim(),
    reasoningEffort: fields.reasoningEffort.value,
    textVerbosity: fields.textVerbosity.value,
    endpoint: fields.endpoint.value.trim(),
    targetLanguage: fields.targetLanguage.value,
    mode: fields.mode.value,
  };
}

async function saveSettings() {
  const patch = readSettings();
  await chrome.runtime.sendMessage({ type: "translator:save-settings", patch });
  setStatus("已保存", "ok");
  return patch;
}

async function testConnection() {
  setStatus("正在测试...", "");
  await saveSettings();
  const result = await chrome.runtime.sendMessage({ type: "translator:test" });
  if (result?.ok) {
    setStatus(`连接成功：${result.sample}`, "ok");
  } else {
    setStatus(result?.error || "连接失败", "error");
  }
}

document.querySelectorAll('input[name="providerMode"]').forEach((input) => {
  input.addEventListener("change", () => setProviderMode(input.value));
});

fields.baseUrl.addEventListener("change", () => {
  const value = fields.baseUrl.value.toLowerCase();
  if (value.includes("colabapi") || value.includes("one-api") || value.includes("new-api")) {
    fields.apiMode.value = "chat";
  }
});

document.querySelector("#save").addEventListener("click", saveSettings);
document.querySelector("#saveTop").addEventListener("click", saveSettings);
document.querySelector("#test").addEventListener("click", testConnection);

loadSettings().catch((error) => setStatus(error.message, "error"));
