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
  const PET_POSITION_KEY = "meepTranslatorPetPosition";
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
    translationByNode: new WeakMap(),
    translationCache: new Map(),
    translated: new WeakSet(),
    showingOriginal: false,
    failed: new WeakSet(),
    toolbar: null,
    dock: null,
    status: null,
    petButton: null,
    drag: null,
    mutationObserver: null,
    scrollTimer: 0,
    translatedCount: 0,
    extensionContextValid: true,
  };

  function isExtensionContextError(error) {
    return String(error?.message || error).includes("Extension context invalidated");
  }

  function hasExtensionContext() {
    try {
      return state.extensionContextValid && Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function markExtensionContextInvalid() {
    state.extensionContextValid = false;
    state.enabled = false;
    state.autoTranslate = false;
    state.queue = [];
    window.clearTimeout(state.scrollTimer);
    detachObservers();
    setStatus("扩展已重新加载，请刷新页面", true);
  }

  function getIconUrl() {
    try {
      return chrome.runtime.getURL("icons/woodcock-128.png");
    } catch {
      return "";
    }
  }

  async function loadPetPosition() {
    if (!hasExtensionContext()) return null;
    try {
      const result = await chrome.storage.local.get(PET_POSITION_KEY);
      const position = result?.[PET_POSITION_KEY];
      if (
        position &&
        Number.isFinite(position.left) &&
        Number.isFinite(position.top)
      ) {
        return position;
      }
    } catch (error) {
      if (isExtensionContextError(error)) markExtensionContextInvalid();
    }
    return null;
  }

  async function savePetPosition(position) {
    if (!hasExtensionContext()) return;
    try {
      await chrome.storage.local.set({ [PET_POSITION_KEY]: position });
    } catch (error) {
      if (isExtensionContextError(error)) markExtensionContextInvalid();
    }
  }

  function clampPetPosition(left, top) {
    const dock = state.dock;
    const width = dock?.offsetWidth || 68;
    const height = dock?.offsetHeight || 54;
    const margin = 8;
    return {
      left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(top, window.innerHeight - height - margin)),
    };
  }

  function applyPetPosition(position) {
    if (!state.dock || !position) return;
    const clamped = clampPetPosition(position.left, position.top);
    state.dock.style.left = `${clamped.left}px`;
    state.dock.style.top = `${clamped.top}px`;
    state.dock.style.right = "auto";
    state.dock.style.bottom = "auto";
  }

  function getCurrentPetPosition() {
    if (!state.dock) return null;
    const rect = state.dock.getBoundingClientRect();
    return clampPetPosition(rect.left, rect.top);
  }

  async function sendMessage(message) {
    if (!hasExtensionContext()) {
      markExtensionContextInvalid();
      return null;
    }

    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (isExtensionContextError(error)) {
        markExtensionContextInvalid();
        return null;
      }
      throw error;
    }
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

  function cacheKeyForText(text) {
    return [
      state.settings?.targetLanguage || "Simplified Chinese",
      state.settings?.sourceLanguage || "auto",
      normalizeText(text),
    ].join("\n---\n");
  }

  function renderTranslation(original, translation) {
    if (state.settings?.mode === "bilingual") {
      return `${original}\n${translation}`;
    }
    return translation;
  }

  function getCachedTranslation(node, original) {
    const key = cacheKeyForText(original);
    const nodeCache = state.translationByNode.get(node);
    if (nodeCache?.key === key) return nodeCache.text;
    return state.translationCache.get(key);
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
      const original = state.originalText.get(node) || node.nodeValue || "";
      const cached = getCachedTranslation(node, original);
      if (cached) {
        applyCachedTranslation(node, cached);
        continue;
      }
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
      const original = state.originalText.get(node) || node.nodeValue || "";
      const cached = getCachedTranslation(node, original);
      if (cached) {
        applyCachedTranslation(node, cached);
        continue;
      }
      const text = normalizeText(original);
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

        if (!result) break;

        if (!result.ok) {
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

      const original = state.originalText.get(node);
      const cacheKey = cacheKeyForText(original);
      state.translationByNode.set(node, { key: cacheKey, text: translatedText });
      state.translationCache.set(cacheKey, translatedText);
      node.nodeValue = renderTranslation(original, translatedText);
      state.translated.add(node);
    });
    state.showingOriginal = false;
  }

  function applyCachedTranslation(node, translatedText) {
    if (!translatedText || !node.parentNode) return false;
    const original = state.originalText.get(node) || node.nodeValue;
    if (!state.originalText.has(node)) {
      state.originalText.set(node, original);
    }
    state.translationByNode.set(node, { key: cacheKeyForText(original), text: translatedText });
    node.nodeValue = renderTranslation(original, translatedText);
    state.translated.add(node);
    state.failed.delete?.(node);
    state.showingOriginal = false;
    return true;
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
        state.translated.delete?.(node);
      }
    }
    state.showingOriginal = true;
  }

  function showCachedTranslations(root = document.body) {
    if (!root) return 0;
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (true) {
      const node = walker.nextNode();
      if (!node) break;
      const original = state.originalText.get(node) || node.nodeValue;
      const cached = getCachedTranslation(node, original);
      if (cached && applyCachedTranslation(node, cached)) {
        count += 1;
      }
    }
    return count;
  }

  async function ensureSettings() {
    const settings = await sendMessage({ type: "translator:get-settings" });
    if (!settings) return null;
    state.settings = settings;
    return state.settings;
  }

  async function startTranslation() {
    if (state.enabled) {
      enqueueVisibleText();
      return;
    }
    const settings = await ensureSettings();
    if (!settings) return;
    if (state.showingOriginal) {
      createToolbar();
      const restored = showCachedTranslations();
      if (restored) {
        setStatus(`已显示缓存译文 ${restored} 段`);
        state.enabled = true;
        state.autoTranslate = true;
        attachObservers();
        scheduleScan(200);
        return;
      }
    }
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
    setStatus("已恢复原文，译文已缓存");
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
    const iconUrl = getIconUrl();
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          color-scheme: light;
          font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .dock {
          position: fixed;
          z-index: 2147483647;
          right: 18px;
          bottom: 18px;
          display: flex;
          flex-direction: row-reverse;
          align-items: flex-end;
          gap: 8px;
          color: #1f2328;
          font-size: 13px;
          line-height: 1.35;
          touch-action: none;
        }
        .pet {
          width: 68px;
          height: 54px;
          padding: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
          cursor: pointer;
          filter: drop-shadow(0 8px 14px rgba(0, 0, 0, 0.24));
          transform-origin: 50% 92%;
          transition: transform 160ms ease, filter 160ms ease;
        }
        .pet:hover,
        .pet:focus-visible {
          transform: translateY(-2px) rotate(-2deg);
          filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.28));
          outline: none;
        }
        .pet img {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: contain;
          pointer-events: none;
          user-select: none;
          transform-origin: 48% 78%;
        }
        :host([data-active="true"]) .pet {
          animation: meep-skitter 640ms steps(4, end) infinite;
        }
        :host([data-active="true"]) .pet img {
          animation: meep-body-wobble 320ms ease-in-out infinite;
        }
        .panel {
          position: absolute;
          top: 6px;
          right: 64px;
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 38px;
          max-width: min(760px, calc(100vw - 104px));
          padding: 8px 10px;
          border: 1px solid rgba(0, 0, 0, 0.12);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.96);
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
          opacity: 0;
          pointer-events: none;
          transform: translateX(8px) translateY(4px) scale(0.98);
          transform-origin: right bottom;
          transition: opacity 140ms ease, transform 140ms ease;
        }
        .dock:hover .panel {
          opacity: 1;
          pointer-events: auto;
          transform: translateX(0) translateY(0) scale(1);
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
        @keyframes meep-skitter {
          0% {
            transform: translateX(0) translateY(0) rotate(-1deg);
          }
          25% {
            transform: translateX(2px) translateY(-1px) rotate(1deg);
          }
          50% {
            transform: translateX(0) translateY(0) rotate(-1deg);
          }
          75% {
            transform: translateX(-2px) translateY(-1px) rotate(1deg);
          }
          100% {
            transform: translateX(0) translateY(0) rotate(-1deg);
          }
        }
        @keyframes meep-body-wobble {
          0%, 100% {
            transform: translateX(-2px) rotate(-4deg) scaleX(1.02) scaleY(0.98);
          }
          50% {
            transform: translateX(3px) rotate(4deg) scaleX(0.98) scaleY(1.02);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .pet,
          .pet img,
          .panel,
          :host([data-active="true"]) .pet {
            animation: none;
            transition: none;
          }
        }
        @media (max-width: 640px) {
          .dock {
            right: 10px;
            bottom: 10px;
            align-items: flex-end;
          }
          .pet {
            width: 60px;
            height: 48px;
          }
          .panel {
            top: 2px;
            right: 56px;
            max-width: calc(100vw - 86px);
            flex-wrap: wrap;
          }
          .status {
            flex: 1 1 140px;
          }
        }
      </style>
      <div class="dock" role="region" aria-label="meep-translator">
        <button class="pet" type="button" title="meep-translator" aria-label="开始翻译页面" aria-pressed="false">
          <img src="${iconUrl}" alt="" />
        </button>
        <div class="panel">
          <span class="title">meep-translator</span>
          <span class="status">待命</span>
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
          <button class="settings" type="button">设置</button>
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);
    state.toolbar = host;
    state.dock = shadow.querySelector(".dock");
    state.status = shadow.querySelector(".status");
    state.petButton = shadow.querySelector(".pet");

    const language = shadow.querySelector(".language");
    const mode = shadow.querySelector(".mode");
    const translate = shadow.querySelector(".translate");
    const pause = shadow.querySelector(".pause");
    const restore = shadow.querySelector(".restore");
    const settings = shadow.querySelector(".settings");

    language.value = state.settings?.targetLanguage || "Simplified Chinese";
    mode.value = state.settings?.mode || "replace";

    language.addEventListener("change", async () => {
      const settings = await sendMessage({
        type: "translator:save-settings",
        patch: { targetLanguage: language.value },
      });
      if (!settings) return;
      state.settings = settings;
      setStatus("目标语言已更新");
    });
    mode.addEventListener("change", async () => {
      const settings = await sendMessage({
        type: "translator:save-settings",
        patch: { mode: mode.value },
      });
      if (!settings) return;
      state.settings = settings;
      setStatus("显示模式已更新");
    });
    state.petButton.addEventListener("pointerdown", handlePetPointerDown);
    state.petButton.addEventListener("click", (event) => {
      if (state.drag?.suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        state.drag.suppressClick = false;
        return;
      }
      startTranslation();
    });
    translate.addEventListener("click", startTranslation);
    pause.addEventListener("click", stopTranslation);
    restore.addEventListener("click", restorePage);
    settings.addEventListener("click", () => {
      void sendMessage({ type: "translator:open-options" });
    });
    loadPetPosition().then(applyPetPosition);
    window.addEventListener("resize", handlePetWindowResize);
  }

  function handlePetWindowResize() {
    const position = getCurrentPetPosition();
    if (!position) return;
    applyPetPosition(position);
    void savePetPosition(position);
  }

  function handlePetPointerDown(event) {
    if (event.button !== 0) return;
    const rect = state.dock.getBoundingClientRect();
    state.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      moved: false,
      suppressClick: false,
    };
    state.petButton.setPointerCapture(event.pointerId);
    state.petButton.addEventListener("pointermove", handlePetPointerMove);
    state.petButton.addEventListener("pointerup", handlePetPointerUp);
    state.petButton.addEventListener("pointercancel", handlePetPointerUp);
  }

  function handlePetPointerMove(event) {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    drag.suppressClick = true;
    event.preventDefault();
    applyPetPosition({
      left: drag.startLeft + dx,
      top: drag.startTop + dy,
    });
  }

  function handlePetPointerUp(event) {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    state.petButton.releasePointerCapture?.(event.pointerId);
    state.petButton.removeEventListener("pointermove", handlePetPointerMove);
    state.petButton.removeEventListener("pointerup", handlePetPointerUp);
    state.petButton.removeEventListener("pointercancel", handlePetPointerUp);
    if (drag.moved) {
      const position = getCurrentPetPosition();
      if (position) void savePetPosition(position);
    }
  }

  function setStatus(text, isError = false) {
    if (!state.status) return;
    state.status.textContent = text;
    state.status.classList.toggle("error", Boolean(isError));
    state.toolbar?.setAttribute("data-active", String(state.enabled));
    state.toolbar?.setAttribute("data-busy", String(state.busy));
    state.petButton?.setAttribute("aria-pressed", String(state.enabled));
  }

  createToolbar();

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
