/**
 * Break Reklams — пипетка «Убрать элемент». Внедряется по требованию (popup, контекстное меню, Alt+Shift+X).
 * Наведите курсор на рекламу → клик → «Скрыть навсегда». Правило сохраняется в «Мои фильтры».
 * Клавиши: ↑ — шире (родитель), ↓ — уже, Enter — сохранить, Esc — выход.
 */
(() => {
  'use strict';
  if (window.__brPicker) window.__brPicker.stop();

  const preselected = window.__brPickerPreselect ? window.__brContextTarget : null;
  window.__brPickerPreselect = false;

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .hl {
      position: fixed; pointer-events: none; z-index: 1;
      border: 2px solid #ff3b30; background: rgba(255, 59, 48, .18);
      border-radius: 3px; box-shadow: 0 0 0 1px rgba(255,255,255,.6);
      transition: all 60ms ease-out;
    }
    .hl[hidden] { display: none; }
    .tag {
      position: absolute; left: -2px; top: -24px; max-width: 420px;
      padding: 3px 7px; border-radius: 4px; background: #ff3b30; color: #fff;
      font: 600 11px/16px ui-monospace, SFMono-Regular, Consolas, monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .hl.below .tag { top: auto; bottom: -24px; }
    .panel {
      position: fixed; right: 16px; bottom: 16px; z-index: 2; width: 340px; max-width: calc(100vw - 32px);
      pointer-events: auto; padding: 14px; border-radius: 14px;
      background: rgba(24, 24, 27, .96); color: #f4f4f5; box-shadow: 0 12px 40px rgba(0,0,0,.45);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      backdrop-filter: blur(8px);
    }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .head b { flex: 1; font-size: 14px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #ff3b30; box-shadow: 0 0 0 3px rgba(255,59,48,.3); }
    .x { all: unset; cursor: pointer; font-size: 20px; line-height: 1; padding: 0 4px; color: #a1a1aa; }
    .x:hover { color: #fff; }
    .hint { margin: 0; color: #a1a1aa; }
    .hint kbd { font: 11px ui-monospace, Consolas, monospace; padding: 1px 5px; border-radius: 4px; background: #3f3f46; color: #e4e4e7; }
    .sel[hidden] { display: none; }
    .css {
      width: 100%; margin: 10px 0 6px; padding: 8px 10px; border-radius: 8px;
      border: 1px solid #3f3f46; background: #09090b; color: #fafafa; outline: none;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    .css:focus { border-color: #ff3b30; }
    .css.bad { border-color: #f59e0b; }
    .count { color: #a1a1aa; font-size: 12px; }
    .count.warn { color: #fbbf24; }
    .row { display: flex; gap: 6px; margin-top: 8px; }
    button.b {
      all: unset; cursor: pointer; flex: 1; text-align: center; padding: 8px 10px; border-radius: 8px;
      background: #27272a; color: #f4f4f5; font-weight: 600; font-size: 12.5px;
    }
    button.b:hover { background: #3f3f46; }
    button.b.primary { background: #e53935; }
    button.b.primary:hover { background: #f44336; }
    button.b:disabled { opacity: .45; cursor: default; }
    .done { margin-top: 8px; color: #4ade80; font-weight: 600; }
    .done[hidden] { display: none; }
  `;

  const host = document.createElement('br-picker-root');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>${CSS_TEXT}</style>
    <div class="hl" hidden><span class="tag"></span></div>
    <div class="panel" role="dialog" aria-label="Break Reklams — убрать элемент">
      <div class="head"><span class="dot"></span><b>Убрать элемент</b><button class="x" data-act="cancel" title="Выход (Esc)">×</button></div>
      <p class="hint">Наведите курсор на рекламу и кликните. <kbd>Esc</kbd> — выход.</p>
      <div class="sel" hidden>
        <input class="css" spellcheck="false" autocomplete="off" aria-label="CSS-селектор">
        <div class="count"></div>
        <div class="row">
          <button class="b" data-act="wider" title="Выбрать родительский блок (↑)">▲ Шире</button>
          <button class="b" data-act="narrower" title="Вернуться к вложенному блоку (↓)">▼ Уже</button>
          <button class="b" data-act="repick" title="Выбрать другой элемент">↺ Заново</button>
        </div>
        <div class="row"><button class="b primary" data-act="save" title="Enter">Скрыть навсегда</button></div>
        <div class="done" hidden>Готово! Правило сохранено в «Мои фильтры».</div>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const hl = $('.hl');
  const tag = $('.tag');
  const selBox = $('.sel');
  const input = $('.css');
  const countEl = $('.count');
  const hint = $('.hint');

  let mode = 'hover';
  let current = null;
  const narrowerStack = [];

  // ─── генерация селектора ─────────────────────────────────────────────────

  const esc = (s) => CSS.escape(s);
  const STATE_CLASS_RE = /^(?:active|hover|focus|focused|selected|visible|hidden|show|shown|open|opened|is-|has-|js-)/;

  function isStableToken(s) {
    if (!s || s.length > 60) return false;
    if (/^(?:css|sc|jsx|svelte|emotion|styled|tw)-/i.test(s)) return false;
    if (/^_/.test(s) && /\d/.test(s)) return false;
    if (/^(?=.*\d)(?=.*[a-zA-Z])[a-zA-Z0-9]{6,}$/.test(s)) return false;
    if (/__[a-zA-Z0-9-]{5,}$/.test(s) && /\d/.test(s)) return false;
    return !/\d{5,}/.test(s);
  }

  function compound(el) {
    const classes = [...el.classList].filter((c) => isStableToken(c) && !STATE_CLASS_RE.test(c)).slice(0, 3);
    return el.localName + classes.map((c) => `.${esc(c)}`).join('');
  }

  function matchesOnly(selector, el) {
    try {
      const list = document.querySelectorAll(selector);
      return list.length === 1 && list[0] === el;
    } catch {
      return false;
    }
  }

  function buildSelector(el) {
    if (el.id && isStableToken(el.id)) {
      const byId = `#${esc(el.id)}`;
      if (matchesOnly(byId, el)) return byId;
    }
    const own = compound(el);
    if (own.includes('.') && matchesOnly(own, el)) return own;

    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node !== el && node.id && isStableToken(node.id)) {
        parts.unshift(`#${esc(node.id)}`);
        break;
      }
      let part = compound(node);
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.localName === node.localName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (matchesOnly(parts.join(' > '), el)) break;
      if (parts.length >= 7) break;
    }
    return parts.join(' > ');
  }

  // ─── отрисовка ───────────────────────────────────────────────────────────

  function highlight(el) {
    if (!el || !el.isConnected) {
      hl.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    hl.hidden = false;
    Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    hl.classList.toggle('below', r.top < 28);
    tag.textContent = `${compound(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function updateCount() {
    const selector = input.value.trim();
    let n = 0;
    try {
      n = selector ? document.querySelectorAll(selector).length : 0;
      input.classList.remove('bad');
    } catch {
      input.classList.add('bad');
      countEl.textContent = 'Ошибка в селекторе';
      countEl.classList.add('warn');
      $('[data-act="save"]').disabled = true;
      return;
    }
    countEl.textContent = n === 1 ? 'Совпадает 1 элемент' : `Совпадений: ${n}`;
    countEl.classList.toggle('warn', n === 0 || n > 10);
    $('[data-act="save"]').disabled = n === 0;
  }

  function select(el) {
    if (!el || el === document.documentElement || el === document.body) return;
    mode = 'selected';
    current = el;
    input.value = buildSelector(el);
    selBox.hidden = false;
    hint.textContent = 'Проверьте выделение и нажмите «Скрыть навсегда».';
    highlight(el);
    updateCount();
  }

  function wider() {
    const parent = current?.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) return;
    narrowerStack.push(current);
    current = parent;
    input.value = buildSelector(current);
    highlight(current);
    updateCount();
  }

  function narrower() {
    if (!narrowerStack.length) return;
    current = narrowerStack.pop();
    input.value = buildSelector(current);
    highlight(current);
    updateCount();
  }

  function repick() {
    mode = 'hover';
    current = null;
    narrowerStack.length = 0;
    selBox.hidden = true;
    hl.hidden = true;
    hint.innerHTML = 'Наведите курсор на рекламу и кликните. <kbd>Esc</kbd> — выход.';
  }

  async function save() {
    const selector = input.value.trim();
    let matched;
    try {
      matched = document.querySelectorAll(selector);
    } catch {
      return;
    }
    if (!matched.length) return;
    for (const el of matched) el.style.setProperty('display', 'none', 'important');
    hl.hidden = true;
    const siteHost = location.hostname.replace(/^www\./, '');
    try {
      await chrome.runtime.sendMessage({ type: 'picker:save', host: siteHost, selector });
    } catch {
      // расширение перезагружено — элемент всё равно скрыт до перезагрузки страницы
    }
    $('.done').hidden = false;
    $('[data-act="save"]').disabled = true;
    setTimeout(stop, 1100);
  }

  // ─── события ─────────────────────────────────────────────────────────────

  const fromPanel = (e) => e.composedPath().includes(host);

  function onMove(e) {
    if (mode !== 'hover' || fromPanel(e)) return;
    highlight(document.elementFromPoint(e.clientX, e.clientY));
  }

  function swallow(e) {
    if (fromPanel(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && e.button === 0 && mode === 'hover') {
      select(document.elementFromPoint(e.clientX, e.clientY));
    }
  }

  function onKey(e) {
    const inInput = fromPanel(e) && e.composedPath()[0] === input;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      stop();
    } else if (e.key === 'Enter' && mode === 'selected') {
      e.preventDefault();
      e.stopImmediatePropagation();
      save();
    } else if (mode === 'selected' && !inInput && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'ArrowUp') wider();
      else narrower();
    }
  }

  const onViewport = () => { if (current) highlight(current); };

  const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  addEventListener('mousemove', onMove, true);
  for (const type of BLOCKED) addEventListener(type, swallow, true);
  addEventListener('keydown', onKey, true);
  addEventListener('scroll', onViewport, true);
  addEventListener('resize', onViewport, true);

  root.addEventListener('click', (e) => {
    const act = e.target.closest?.('[data-act]')?.dataset.act;
    if (act === 'cancel') stop();
    else if (act === 'wider') wider();
    else if (act === 'narrower') narrower();
    else if (act === 'repick') repick();
    else if (act === 'save') save();
  });
  input.addEventListener('input', () => {
    updateCount();
    try {
      const first = document.querySelector(input.value.trim());
      if (first) highlight(first);
    } catch {
      // ждём, пока пользователь допишет селектор
    }
  });

  function stop() {
    removeEventListener('mousemove', onMove, true);
    for (const type of BLOCKED) removeEventListener(type, swallow, true);
    removeEventListener('keydown', onKey, true);
    removeEventListener('scroll', onViewport, true);
    removeEventListener('resize', onViewport, true);
    host.remove();
    if (window.__brPicker === api) window.__brPicker = null;
  }

  const api = { stop };
  window.__brPicker = api;

  if (preselected instanceof Element && preselected.isConnected) select(preselected);
})();
