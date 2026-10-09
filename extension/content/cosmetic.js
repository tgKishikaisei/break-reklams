/**
 * Break Reklams — косметическая фильтрация (изолированный мир, все фреймы, document_start).
 *  • просит service worker внедрить CSS для этого сайта;
 *  • следит за классами/id на странице и догружает подходящие общие селекторы;
 *  • убирает окна «отключите AdBlock» и возвращает прокрутку.
 */
(() => {
  'use strict';
  if (window.__brCosmeticLoaded) return;
  window.__brCosmeticLoaded = true;

  const send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // расширение перезагрузили — страница живёт со старым скриптом
    }
  };

  const seenTokens = new Set();
  let active = false;
  let removedCount = 0;

  // Элемент под правым кликом — для пункта контекстного меню «убрать этот элемент».
  document.addEventListener('contextmenu', (e) => { window.__brContextTarget = e.target; }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'stats:hidden') return false;
    countHidden().then((hidden) => sendResponse({ hidden }), () => sendResponse({ hidden: 0 }));
    return true;
  });

  send({ type: 'cosmetic:init' }).then((state) => {
    if (!state?.active) return;
    active = true;
    if (state.generic) startTokenScan();
    if (state.antiAdblock) startAntiAdblock();
  });

  // ─── ленивые общие селекторы ────────────────────────────────────────────────

  function startTokenScan() {
    const pending = new Set();
    let timer = 0;

    const flush = () => {
      timer = 0;
      if (!pending.size) return;
      const tokens = [...pending];
      pending.clear();
      send({ type: 'cosmetic:tokens', tokens });
    };
    const addToken = (token) => {
      if (seenTokens.has(token)) return;
      seenTokens.add(token);
      pending.add(token);
      timer ||= setTimeout(flush, 40);
    };
    const addElement = (el) => {
      const id = el.id;
      if (id && typeof id === 'string') addToken(`#${id}`);
      const list = el.classList;
      if (list) for (let i = 0; i < list.length; i++) addToken(`.${list[i]}`);
    };
    const scanTree = (root) => {
      if (root.nodeType !== 1) return;
      addElement(root);
      for (const el of root.querySelectorAll('[id],[class]')) addElement(el);
    };

    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') addElement(m.target);
        else for (const node of m.addedNodes) scanTree(node);
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'class'] });

    if (document.documentElement) scanTree(document.documentElement);
  }

  async function countHidden() {
    if (!active) return 0;
    const res = await send({ type: 'cosmetic:selectors', tokens: [...seenTokens] });
    const found = new Set();
    for (const selector of res?.selectors || []) {
      try {
        for (const el of document.querySelectorAll(selector)) found.add(el);
      } catch {
        // селектор не поддерживается этим браузером
      }
    }
    return found.size + removedCount;
  }

  // ─── анти-антиблок ──────────────────────────────────────────────────────────

  const WALL_RE = /ad[\s-]?block|ad[\s-]?blocker|блокировщик|блокировку рекламы|отключите.{0,40}(?:реклам|блок)|disable.{0,40}(?:\bads?\b|blocker)|whitelist|allowlist|белый список|werbeblocker|bloqueur de pub/i;

  function startAntiAdblock() {
    let timer = 0;
    let runs = 0;
    const check = () => {
      timer = 0;
      if (++runs > 300) return;
      try {
        scanForWalls();
      } catch {
        // страница в процессе перестройки — попробуем позже
      }
    };
    const schedule = (delay = 400) => { timer ||= setTimeout(check, delay); };
    const observer = new MutationObserver(() => schedule());
    const begin = () => {
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      schedule(0);
      setTimeout(() => observer.disconnect(), 90_000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
    else begin();
  }

  const viewportArea = () => innerWidth * innerHeight;

  /** Самый внешний «слой» (fixed или большой absolute), в котором лежит элемент. */
  function layerOf(el) {
    let found = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') found = n;
      else if (pos === 'absolute') {
        const r = n.getBoundingClientRect();
        if (r.width * r.height >= 0.5 * viewportArea()) found = n;
      }
    }
    return found;
  }

  function scanForWalls() {
    const vw = innerWidth;
    const vh = innerHeight;
    if (!vw || !vh || !document.body) return;

    const layers = new Set();
    for (const [x, y] of [[vw / 2, vh / 2], [vw / 2, vh / 3], [vw / 2, (vh * 2) / 3]]) {
      for (const el of document.elementsFromPoint(x, y)) {
        const layer = layerOf(el);
        if (layer) layers.add(layer);
      }
    }

    let wall = null;
    for (const layer of layers) {
      const text = (layer.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length && text.length < 1500 && WALL_RE.test(text) && !layer.querySelector('article, main, video')) {
        wall = layer;
        break;
      }
    }
    if (!wall) return;

    wall.remove();
    removedCount++;
    // Полупрозрачные подложки под окном — тоже долой.
    for (const layer of layers) {
      if (layer === wall || !layer.isConnected) continue;
      const r = layer.getBoundingClientRect();
      if (r.width * r.height >= 0.6 * vw * vh && (layer.textContent || '').trim().length < 30) {
        layer.remove();
        removedCount++;
      }
    }
    unlockPage();
  }

  function unlockPage() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
        el.style.setProperty('overflow', 'auto', 'important');
        el.style.setProperty('overflow-y', 'auto', 'important');
      }
      if (cs.position === 'fixed') el.style.setProperty('position', 'static', 'important');
      if (cs.filter && cs.filter !== 'none') el.style.setProperty('filter', 'none', 'important');
    }
    for (const child of document.body.children) {
      const cs = getComputedStyle(child);
      if (cs.filter && cs.filter.includes('blur')) child.style.setProperty('filter', 'none', 'important');
    }
  }
})();
