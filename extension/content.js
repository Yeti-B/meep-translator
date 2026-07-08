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
    inFlight: new WeakSet(),
    originalText: new WeakMap(),
    translationByNode: new WeakMap(),
    translationCache: new Map(),
    translated: new WeakSet(),
    partiallyTranslated: new WeakSet(),
    showingOriginal: false,
    failed: new WeakSet(),
    selectionBusy: false,
    toolbar: null,
    dock: null,
    status: null,
    petButton: null,
    petImage: null,
    idleIconUrl: "",
    activeIconUrl: "",
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
    state.queued = new WeakSet();
    state.inFlight = new WeakSet();
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

  function getAnimatedIconUrl() {
    try {
      return chrome.runtime.getURL("icons/woodcock-meep.webp");
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

  function isFullyTranslated(node) {
    return state.translated.has(node) && !state.partiallyTranslated.has(node);
  }

  function getCachedTranslation(node, original) {
    const key = cacheKeyForText(original);
    const nodeCache = state.translationByNode.get(node);
    if (nodeCache?.key === key) return nodeCache.text;
    return state.translationCache.get(key);
  }

  function shouldTranslateNode(node, options = {}) {
    if (
      isFullyTranslated(node) ||
      state.inFlight.has(node) ||
      state.failed.has(node) ||
      (!options.includeQueued && state.queued.has(node))
    ) {
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

  function collectCandidateNodes(root = document.body, options = {}) {
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return shouldTranslateNode(node, options) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
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

  function prioritizeQueuedNodes(nodes) {
    if (!nodes.length) return;
    const priorityNodes = [];
    const seen = new Set();

    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      priorityNodes.push(node);
      state.queued.add(node);
    }

    state.queue = [
      ...priorityNodes,
      ...state.queue.filter((node) => !seen.has(node)),
    ];
  }

  function enqueueVisibleText(root) {
    if (!state.enabled) return;
    const nodesToPrioritize = [];
    for (const node of collectCandidateNodes(root, { includeQueued: true })) {
      const original = state.originalText.get(node) || node.nodeValue || "";
      const cached = getCachedTranslation(node, original);
      if (cached) {
        applyCachedTranslation(node, cached);
        continue;
      }
      nodesToPrioritize.push(node);
    }
    prioritizeQueuedNodes(nodesToPrioritize);
    if (state.queue.length && !state.busy) processQueue();
  }

  function buildBatch() {
    const nodes = [];
    const texts = [];
    let charCount = 0;

    while (state.queue.length && nodes.length < MAX_BATCH_ITEMS) {
      const node = state.queue.shift();
      state.queued.delete(node);
      const original = state.originalText.get(node) || node.nodeValue || "";
      const cached = getCachedTranslation(node, original);
      if (cached) {
        applyCachedTranslation(node, cached);
        continue;
      }
      const text = normalizeText(original);
      if (!text || isFullyTranslated(node) || state.failed.has(node) || isSkippableNode(node)) {
        continue;
      }
      if (charCount + text.length > MAX_BATCH_CHARS && nodes.length) {
        state.queue.unshift(node);
        state.queued.add(node);
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
        for (const node of nodes) state.inFlight.add(node);
        setStatus(`正在翻译 ${nodes.length} 段...`);

        const result = await sendMessage({
          type: "translator:translate",
          texts,
          pageTitle: document.title,
          pageUrl: location.href,
        });

        if (!result) {
          for (const node of nodes) state.inFlight.delete(node);
          break;
        }

        if (!result.ok) {
          for (const node of nodes) {
            state.failed.add(node);
            state.inFlight.delete(node);
          }
          setStatus(result?.error || "翻译失败，请检查本地代理。", true);
          await sleep(1200);
          break;
        }

        const appliedCount = applyTranslations(nodes, result.translations || []);
        state.translatedCount += appliedCount;
        setStatus(`已翻译 ${state.translatedCount} 段`);
        await sleep(60);
      }
    } finally {
      state.busy = false;
      updatePetState();
      if (state.enabled && state.autoTranslate) scheduleScan(300);
    }
  }

  function applyTranslations(nodes, translations) {
    let appliedCount = 0;
    nodes.forEach((node, index) => {
      const translatedText = translations[index];
      if (!translatedText || !node.parentNode) {
        state.failed.add(node);
        state.inFlight.delete(node);
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
      state.inFlight.delete(node);
      state.partiallyTranslated.delete(node);
      state.failed.delete(node);
      appliedCount += 1;
    });
    state.showingOriginal = false;
    return appliedCount;
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
    state.partiallyTranslated.delete(node);
    state.failed.delete(node);
    state.showingOriginal = false;
    return true;
  }

  function collectSelectedTextItems() {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return [];

    const items = [];
    for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
      const range = selection.getRangeAt(rangeIndex);
      if (range.collapsed || !normalizeText(range.toString())) continue;

      const root =
        range.commonAncestorContainer.nodeType === Node.TEXT_NODE
          ? range.commonAncestorContainer.parentNode
          : range.commonAncestorContainer;
      if (!root) continue;

      const addNode = (node) => {
        if (isSkippableNode(node)) return;
        const value = node.nodeValue || "";
        let start = node === range.startContainer ? range.startOffset : 0;
        let end = node === range.endContainer ? range.endOffset : value.length;
        start = Math.max(0, Math.min(start, value.length));
        end = Math.max(start, Math.min(end, value.length));
        const selectedText = value.slice(start, end);
        const text = normalizeText(selectedText);
        if (text.length < 2) return;
        if (!/[A-Za-z\u00C0-\u024F\u0400-\u052F\u3040-\u30FF\uAC00-\uD7AF]/.test(text)) return;
        if (/^[\d\s.,:;!?()[\]{}'"“”‘’/@#$%^&*+=|\\-]+$/.test(text)) return;
        items.push({ node, start, end, text: selectedText, normalizedText: text });
      };

      if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE) {
        addNode(range.commonAncestorContainer);
        continue;
      }

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          try {
            return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          } catch {
            return NodeFilter.FILTER_REJECT;
          }
        },
      });

      while (true) {
        const node = walker.nextNode();
        if (!node) break;
        addNode(node);
      }
    }

    return items;
  }

  function removeNodesFromQueue(nodesToRemove) {
    if (!nodesToRemove.size || !state.queue.length) return;
    state.queue = state.queue.filter((node) => {
      if (!nodesToRemove.has(node)) return true;
      state.queued.delete(node);
      return false;
    });
  }

  function buildSelectionBatches(items) {
    const batches = [];
    let batch = [];
    let charCount = 0;
    for (const item of items) {
      const length = item.normalizedText.length;
      if (batch.length && (batch.length >= MAX_BATCH_ITEMS || charCount + length > MAX_BATCH_CHARS)) {
        batches.push(batch);
        batch = [];
        charCount = 0;
      }
      batch.push(item);
      charCount += length;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  function applySelectedTranslations(items, translations) {
    let appliedCount = 0;
    const indexedItems = items.map((item, index) => ({ ...item, translation: translations[index] }));
    indexedItems.sort((a, b) => {
      if (a.node === b.node) return b.start - a.start;
      const position = a.node.compareDocumentPosition(b.node);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return 1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return -1;
      return 0;
    });

    for (const item of indexedItems) {
      if (!item.translation || !item.node.parentNode) {
        state.failed.add(item.node);
        continue;
      }
      const currentText = item.node.nodeValue || "";
      if (item.end > currentText.length) {
        state.failed.add(item.node);
        continue;
      }
      if (!state.originalText.has(item.node)) {
        state.originalText.set(item.node, currentText);
      }
      const selectedText = currentText.slice(item.start, item.end);
      const replacement = renderTranslation(selectedText, item.translation);
      item.node.nodeValue =
        currentText.slice(0, item.start) + replacement + currentText.slice(item.end);
      state.translationCache.set(cacheKeyForText(item.text), item.translation);
      state.translated.add(item.node);
      state.partiallyTranslated.add(item.node);
      state.failed.delete(item.node);
      appliedCount += 1;
    }
    state.showingOriginal = false;
    return appliedCount;
  }

  async function translateSelection() {
    const items = collectSelectedTextItems();
    if (!items.length) return false;
    if (state.selectionBusy) {
      setStatus("正在翻译，请稍候...");
      return true;
    }

    const settings = await ensureSettings();
    if (!settings) return true;
    createToolbar();
    removeNodesFromQueue(new Set(items.map((item) => item.node)));
    for (const item of items) {
      state.failed.delete(item.node);
    }
    state.selectionBusy = true;
    updatePetState();

    let appliedCount = 0;
    try {
      const batches = buildSelectionBatches(items);
      for (const batch of batches) {
        setStatus(`正在翻译选中内容 ${batch.length} 段...`);
        const result = await sendMessage({
          type: "translator:translate",
          texts: batch.map((item) => item.normalizedText),
          pageTitle: document.title,
          pageUrl: location.href,
        });

        if (!result) break;
        if (!result.ok) {
          for (const item of batch) state.failed.add(item.node);
          setStatus(result?.error || "翻译失败，请检查本地代理。", true);
          return true;
        }
        appliedCount += applySelectedTranslations(batch, result.translations || []);
      }
      window.getSelection?.()?.removeAllRanges();
      setStatus(`已翻译选中内容 ${appliedCount} 段`);
      return true;
    } finally {
      state.selectionBusy = false;
      updatePetState();
      if (state.enabled && state.queue.length && !state.busy) processQueue();
    }
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
        state.translated.delete(node);
        state.partiallyTranslated.delete(node);
        state.failed.delete(node);
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
      state.failed = new WeakSet();
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
    state.queued = new WeakSet();
    state.failed = new WeakSet();
    createToolbar();
    setStatus("准备翻译...");
    attachObservers();
    enqueueVisibleText();
  }

  function stopTranslation() {
    state.enabled = false;
    state.autoTranslate = false;
    state.queue = [];
    state.queued = new WeakSet();
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
          if (mutation.type === "characterData") {
            const target = mutation.target;
            if (target.nodeType === Node.TEXT_NODE && !state.translated.has(target)) {
              scheduleScan(500, target.parentElement || document.body);
            }
          }
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) scheduleScan(500, node);
            if (node.nodeType === Node.TEXT_NODE) scheduleScan(500, node.parentElement || document.body);
          }
        }
      });
      state.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
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
    const animatedIconUrl = getAnimatedIconUrl();
    state.idleIconUrl = iconUrl;
    state.activeIconUrl = animatedIconUrl || iconUrl;
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
          position: relative;
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
          position: absolute;
          inset: 0;
          display: block;
          width: 100%;
          height: 100%;
          object-fit: contain;
          pointer-events: none;
          user-select: none;
        }
        .panel {
          position: absolute;
          top: 6px;
          right: 64px;
          display: flex;
          align-items: center;
          gap: 8px;
          box-sizing: border-box;
          width: max-content;
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
          flex: 0 0 auto;
          font-weight: 600;
          white-space: nowrap;
        }
        .status {
          flex: 0 1 220px;
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
          flex: 0 0 auto;
          box-sizing: border-box;
          min-height: 28px;
          border: 1px solid rgba(0, 0, 0, 0.16);
          border-radius: 6px;
          background: #fff;
          color: #1f2328;
          font: inherit;
          white-space: nowrap;
        }
        button {
          min-width: 48px;
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
        .language {
          min-width: 112px;
        }
        .mode {
          min-width: 76px;
        }
        @media (prefers-reduced-motion: reduce) {
          .pet,
          .pet img,
          .panel {
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
            width: calc(100vw - 86px);
            max-width: calc(100vw - 86px);
            flex-wrap: wrap;
          }
          .title {
            flex: 1 1 100%;
          }
          .status {
            flex: 1 1 100%;
            max-width: none;
          }
          button {
            flex: 1 1 72px;
          }
          select {
            flex: 1 1 132px;
            min-width: 0;
          }
        }
      </style>
      <div class="dock" role="region" aria-label="meep-translator">
        <button class="pet" type="button" title="meep-translator" aria-label="开始翻译页面" aria-pressed="false">
          <img src="${iconUrl}" alt="" aria-hidden="true" />
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
    state.petImage = shadow.querySelector(".pet img");

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
    translate.addEventListener("mousedown", (event) => event.preventDefault());
    translate.addEventListener("click", async () => {
      const handledSelection = await translateSelection();
      if (!handledSelection) startTranslation();
    });
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
    if (state.status) {
      state.status.textContent = text;
      state.status.classList.toggle("error", Boolean(isError));
    }
    updatePetState();
  }

  function updatePetState() {
    const isBusy = state.busy || state.selectionBusy;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    state.toolbar?.setAttribute("data-active", String(state.enabled));
    state.toolbar?.setAttribute("data-busy", String(isBusy));
    state.petButton?.setAttribute("aria-pressed", String(state.enabled));
    if (state.petImage) {
      const nextSrc = isBusy && !reduceMotion ? state.activeIconUrl : state.idleIconUrl;
      if (nextSrc && state.petImage.src !== nextSrc) {
        state.petImage.src = nextSrc;
      }
    }
  }

  createToolbar();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "translator:start") {
      startTranslation();
    }
    if (message?.type === "translator:translate-selection") {
      translateSelection();
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
