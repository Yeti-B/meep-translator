const fields = {
  apiKey: document.querySelector("#apiKey"),
  baseUrl: document.querySelector("#baseUrl"),
  apiMode: document.querySelector("#apiMode"),
  modelPreset: document.querySelector("#modelPreset"),
  customModel: document.querySelector("#customModel"),
  reasoningEffort: document.querySelector("#reasoningEffort"),
  textVerbosity: document.querySelector("#textVerbosity"),
  endpoint: document.querySelector("#endpoint"),
  targetLanguage: document.querySelector("#targetLanguage"),
  mode: document.querySelector("#mode"),
};

const directPanel = document.querySelector("#directPanel");
const proxyPanel = document.querySelector("#proxyPanel");
const statusEl = document.querySelector("#status");
const DEFAULT_MODEL = "gpt-5.4-mini";
const MODEL_PRESETS = new Set(["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"]);
const UNSUPPORTED_PRESET_MODELS = new Set(["gpt-5.4-nano"]);

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
  const settings = await chrome.runtime.sendMessage({ type: "translator:get-private-settings" });
  setProviderMode(settings.providerMode || "direct");
  fields.apiKey.value = settings.apiKey || "";
  fields.baseUrl.value = settings.baseUrl || "";
  fields.apiMode.value = settings.apiMode || "responses";
  fields.reasoningEffort.value = settings.reasoningEffort || "low";
  fields.textVerbosity.value = settings.textVerbosity || "low";
  fields.endpoint.value = settings.endpoint || "";
  fields.targetLanguage.value = settings.targetLanguage || "Simplified Chinese";
  fields.mode.value = settings.mode || "replace";

  const storedModel = UNSUPPORTED_PRESET_MODELS.has(settings.model)
    ? DEFAULT_MODEL
    : settings.model || DEFAULT_MODEL;
  if (MODEL_PRESETS.has(storedModel)) {
    fields.modelPreset.value = storedModel;
    fields.customModel.value = "";
  } else {
    fields.modelPreset.value = "custom";
    fields.customModel.value = storedModel;
  }
}

function readSettings() {
  const selectedModel =
    fields.modelPreset.value === "custom"
      ? fields.customModel.value.trim()
      : fields.modelPreset.value;
  return {
    providerMode: providerMode(),
    apiKey: fields.apiKey.value.trim(),
    baseUrl: fields.baseUrl.value.trim(),
    apiMode: fields.apiMode.value,
    modelPreset: fields.modelPreset.value,
    model: selectedModel,
    reasoningEffort: fields.reasoningEffort.value,
    textVerbosity: fields.textVerbosity.value,
    endpoint: fields.endpoint.value.trim(),
    targetLanguage: fields.targetLanguage.value,
    mode: fields.mode.value,
  };
}

async function saveSettings() {
  const patch = readSettings();
  if (patch.providerMode === "direct" && !patch.model) {
    setStatus("请先选择模型，或填写自定义模型名。", "error");
    throw new Error("Model is required.");
  }
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

fields.modelPreset.addEventListener("change", () => {
  if (fields.modelPreset.value === "custom") {
    fields.customModel.focus();
  }
});

fields.customModel.addEventListener("input", () => {
  if (fields.customModel.value.trim()) {
    fields.modelPreset.value = "custom";
  }
});

document.querySelector("#save").addEventListener("click", saveSettings);
document.querySelector("#saveTop").addEventListener("click", saveSettings);
document.querySelector("#test").addEventListener("click", testConnection);

loadSettings().catch((error) => setStatus(error.message, "error"));
