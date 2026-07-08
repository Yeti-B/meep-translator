(() => {
  if (window.__localOpenAIPageTranslator) return;
  window.__localOpenAIPageTranslator = true;

  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "IFRAME",
    "CANVAS",
    "SVG",
    "VIDEO",
    "AUDIO",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
    "CODE",
    "PRE",
    "KBD",
    "SAMP",
  ]);
  const UI_ID = "local-openai-page-translator";
  const MAX_BATCH_ITEMS = 32;
  const MAX_BATCH_CHARS = 4200;

  const state = {
    enabled: false,
    busy: false,
    autoTranslate: true,
    settings: null,
    queue: [],
    queued: new WeakSet(),
    originalText: new WeakMap(),
    translated: new WeakSet(),
    failed: new WeakSet(),
    toolbar: null,
    status: null,
    mutationObserver: null,
    scrollTimer: 0,
    translatedCount: 0,
  };

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isSkippableNode(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.closest(`#${UI_ID}`)) return true;
    if (parent.isContentEditable) return true;
    for (let el = parent; el; el = el.parentElement) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.getAttribute("translate") === "no") return true;
      if (el.getAttribute("aria-hidden") === "true") return true;
    }
    return false;
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function shouldTranslateNode(node) {
    if (state.translated.has(node) || state.failed.has(node) || state.queued.has(node)) {
      return false;
    }
    if (isSkippableNode(node)) return false;
    const text = normalizeText(node.nodeValue || "");
    if (text.length < 2) return false;
    if (!/[A-Za-z\u00C0-\u024F\u0400-\u052F\u3040-\u30FF\uAC00-\uD7AF]/.test(text)) {
      return false;
    }
    if (/^[\d\s.,:;!?()[\]{}'"“”‘’/@#$%^&*+=|\\-]+$/.test(text)) {
      return false;
    }
    return isNearViewport(node.parentElement);
  }

  function isNearViewport(element) {
    if (!element || element.offsetParent === null) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const margin = Math.max(window.innerHeight * 1.5, 900);
    return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
  }

  function collectCandidateNodes(root = document.body) {
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return shouldTranslateNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const nodes = [];
    while (nodes.length < 140) {
      const node = walker.nextNode();
      if (!node) break;
      nodes.push(node);
    }
    return nodes;
  }

  function enqueueVisibleText(root) {
    if (!state.enabled || state.busy) return;
    for (const node of collectCandidateNodes(root)) {
      state.queue.push(node);
      state.queued.add(node);
    }
    if (state.queue.length) processQueue();
  }

  function buildBatch() {
    const nodes = [];
    const texts = [];
    let charCount = 0;

    while (state.queue.length && nodes.length < MAX_BATCH_ITEMS) {
      const node = state.queue.shift();
      const text = normalizeText(node.nodeValue || "");
      if (!text || state.translated.has(node) || state.failed.has(node) || isSkippableNode(node)) {
        continue;
      }
      if (charCount + text.length > MAX_BATCH_CHARS && nodes.length) {
        state.queue.unshift(node);
        break;
      }
      nodes.push(node);
      texts.push(text);
      charCount += text.length;
    }
    return { nodes, texts };
  }

  async function processQueue() {
    if (state.busy || !state.enabled) return;
    state.busy = true;

    try {
      while (state.enabled && state.queue.length) {
        const { nodes, texts } = buildBatch();
        if (!nodes.length) break;
        setStatus(`正在翻译 ${nodes.length} 段...`);

        const result = await sendMessage({
          type: "translator:translate",
          texts,
          pageTitle: document.title,
          pageUrl: location.href,
        });

        if (!result?.ok) {
          for (const node of nodes) state.failed.add(node);
          setStatus(result?.error || "翻译失败，请检查本地代理。", true);
          await sleep(1200);
          break;
        }

        applyTranslations(nodes, result.translations || []);
        state.translatedCount += nodes.length;
        setStatus(`已翻译 ${state.translatedCount} 段`);
        await sleep(60);
      }
    } finally {
      state.busy = false;
      if (state.enabled && state.autoTranslate) scheduleScan(300);
    }
  }

  function applyTranslations(nodes, translations) {
    nodes.forEach((node, index) => {
      const translatedText = translations[index];
      if (!translatedText || !node.parentNode) {
        state.failed.add(node);
        return;
      }
      if (!state.originalText.has(node)) {
        state.originalText.set(node, node.nodeValue);
      }

      if (state.settings?.mode === "bilingual") {
        node.nodeValue = `${state.originalText.get(node)}\n${translatedText}`;
      } else {
        node.nodeValue = translatedText;
      }
      state.translated.add(node);
    });
  }

  function restoreOriginals(root = document.body) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (true) {
      const node = walker.nextNode();
      if (!node) break;
      const original = state.originalText.get(node);
      if (original !== undefined) {
        node.nodeValue = original;
      }
    }
  }

  async function ensureSettings() {
    state.settings = await sendMessage({ type: "translator:get-settings" });
    return state.settings;
  }

  async function startTranslation() {
    if (state.enabled) {
      enqueueVisibleText();
      return;
    }
    await ensureSettings();
    state.enabled = true;
    state.autoTranslate = true;
    state.translatedCount = 0;
    state.queue = [];
    createToolbar();
    setStatus("准备翻译...");
    attachObservers();
    enqueueVisibleText();
  }

  function stopTranslation() {
    state.enabled = false;
    state.autoTranslate = false;
    state.queue = [];
    detachObservers();
    setStatus("已暂停");
  }

  function restorePage() {
    stopTranslation();
    restoreOriginals();
    state.translatedCount = 0;
    setStatus("已恢复原文");
  }

  function attachObservers() {
    if (!state.mutationObserver) {
      state.mutationObserver = new MutationObserver((mutations) => {
        if (!state.enabled || !state.autoTranslate) return;
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) scheduleScan(500, node);
          }
        }
      });
      state.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
    window.addEventListener("scroll", handleScroll, { passive: true });
  }

  function detachObservers() {
    window.removeEventListener("scroll", handleScroll);
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
      state.mutationObserver = null;
    }
  }

  function handleScroll() {
    if (!state.enabled || !state.autoTranslate) return;
    scheduleScan(250);
  }

  function scheduleScan(delay = 300, root) {
    window.clearTimeout(state.scrollTimer);
    state.scrollTimer = window.setTimeout(() => enqueueVisibleText(root), delay);
  }

  function createToolbar() {
    if (state.toolbar) return;

    const host = document.createElement("div");
    host.id = UI_ID;
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          color-scheme: light;
          font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .bar {
          position: fixed;
          z-index: 2147483647;
          top: 12px;
          right: 12px;
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 38px;
          max-width: min(720px, calc(100vw - 24px));
          padding: 8px 10px;
          border: 1px solid rgba(0, 0, 0, 0.12);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.96);
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
          color: #1f2328;
          font-size: 13px;
          line-height: 1.35;
        }
        .title {
          font-weight: 600;
          white-space: nowrap;
        }
        .status {
          max-width: 240px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #4b5563;
        }
        .status.error {
          color: #b42318;
        }
        button, select {
          min-height: 28px;
          border: 1px solid rgba(0, 0, 0, 0.16);
          border-radius: 6px;
          background: #fff;
          color: #1f2328;
          font: inherit;
        }
        button {
          padding: 0 9px;
          cursor: pointer;
        }
        button.primary {
          border-color: #2563eb;
          background: #2563eb;
          color: #fff;
        }
        select {
          padding: 0 24px 0 8px;
        }
        @media (max-width: 640px) {
          .bar {
            left: 8px;
            right: 8px;
            top: 8px;
            flex-wrap: wrap;
          }
          .status {
            flex: 1 1 140px;
          }
        }
      </style>
      <div class="bar" role="region" aria-label="OpenAI page translator">
        <span class="title">OpenAI 翻译</span>
        <span class="status">准备中</span>
        <select class="language" title="目标语言">
          <option value="Simplified Chinese">简体中文</option>
          <option value="Traditional Chinese">繁体中文</option>
          <option value="English">English</option>
          <option value="Japanese">日本語</option>
          <option value="Korean">한국어</option>
        </select>
        <select class="mode" title="显示模式">
          <option value="replace">替换</option>
          <option value="bilingual">双语</option>
        </select>
        <button class="primary translate" type="button">翻译</button>
        <button class="pause" type="button">暂停</button>
        <button class="restore" type="button">原文</button>
      </div>
    `;

    document.documentElement.appendChild(host);
    state.toolbar = host;
    state.status = shadow.querySelector(".status");

    const language = shadow.querySelector(".language");
    const mode = shadow.querySelector(".mode");
    const translate = shadow.querySelector(".translate");
    const pause = shadow.querySelector(".pause");
    const restore = shadow.querySelector(".restore");

    language.value = state.settings?.targetLanguage || "Simplified Chinese";
    mode.value = state.settings?.mode || "replace";

    language.addEventListener("change", async () => {
      state.settings = await sendMessage({
        type: "translator:save-settings",
        patch: { targetLanguage: language.value },
      });
      setStatus("目标语言已更新");
    });
    mode.addEventListener("change", async () => {
      state.settings = await sendMessage({
        type: "translator:save-settings",
        patch: { mode: mode.value },
      });
      setStatus("显示模式已更新");
    });
    translate.addEventListener("click", startTranslation);
    pause.addEventListener("click", stopTranslation);
    restore.addEventListener("click", restorePage);
  }

  function setStatus(text, isError = false) {
    if (!state.status) return;
    state.status.textContent = text;
    state.status.classList.toggle("error", Boolean(isError));
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "translator:start") {
      startTranslation();
    }
    if (message?.type === "translator:toggle") {
      if (state.enabled) stopTranslation();
      else startTranslation();
    }
    if (message?.type === "translator:restore") {
      restorePage();
    }
  });
})();
