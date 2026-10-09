/**
 * Break Reklams — скриптлеты: маленькие функции, которые выполняются в мире страницы (MAIN)
 * раньше её собственных скриптов и обезвреживают детекторы блокировщиков и рекламный код.
 * Синтаксис фильтров uBlock Origin:  example.com##+js(set-constant, canRunAds, true)
 *              и AdGuard:            example.com#%#//scriptlet('set-constant', 'canRunAds', 'true')
 *
 * runScriptlets() и lookupScriptlets() самодостаточны (не используют ничего из модуля):
 * их исходный код встраивается в сгенерированный файл и передаётся в chrome.scripting.executeScript.
 */

const ALIASES = {
  'set-constant': ['set'],
  'abort-on-property-read': ['aopr'],
  'abort-on-property-write': ['aopw'],
  'abort-current-script': ['acs', 'abort-current-inline-script', 'acis'],
  'abort-on-stack-trace': ['aost'],
  'no-setTimeout-if': ['nostif', 'prevent-setTimeout', 'setTimeout-defuser'],
  'no-setInterval-if': ['nosiif', 'prevent-setInterval', 'setInterval-defuser'],
  'addEventListener-defuser': ['aeld', 'prevent-addEventListener'],
  'json-prune': [],
  'remove-attr': ['ra'],
  'remove-class': ['rc'],
  'no-fetch-if': ['prevent-fetch'],
  'no-xhr-if': ['prevent-xhr'],
  'no-window-open-if': ['nowoif', 'window.open-defuser', 'prevent-window-open'],
  'nano-setTimeout-booster': ['nano-stb', 'adjust-setTimeout'],
  'nano-setInterval-booster': ['nano-sib', 'adjust-setInterval'],
  'noeval-if': ['noeval', 'silent-noeval', 'prevent-eval-if'],
  'set-local-storage-item': [],
  'set-session-storage-item': [],
  'remove-node-text': ['rmnt'],
  'nobab': ['bab-defuser', 'prevent-bab'],
  'nofab': ['fuckadblock.js-3.2.0', 'prevent-fab-3.2.0'],
};

const NAME_MAP = new Map();
for (const [canonical, aliases] of Object.entries(ALIASES)) {
  for (const name of [canonical, ...aliases]) NAME_MAP.set(name.toLowerCase(), canonical);
}

/** `nostif.js`, `ubo-no-setTimeout-if`, `prevent-setTimeout` → `no-setTimeout-if`; null — если не поддерживается. */
export function normalizeScriptletName(name) {
  const n = String(name).trim().toLowerCase().replace(/^ubo-/, '').replace(/\.js$/, '');
  return NAME_MAP.get(n) || null;
}

export const SUPPORTED_SCRIPTLETS = Object.keys(ALIASES);

/**
 * Скриптлеты для хоста из таблицы { hosts: {host: [[name, ...args]]}, exceptions: {host: [key]} }.
 * Ключ исключения — JSON записи; пустая строка — «отключить все скриптлеты на сайте».
 */
export function lookupScriptlets(table, hostname) {
  const labels = String(hostname || '').split('.');
  const candidates = [];
  for (let i = 0; i < labels.length; i++) candidates.push(labels.slice(i).join('.'));
  for (let i = 0; i < labels.length - 1; i++) {
    for (let tail = 1; tail <= 2 && i + tail < labels.length; tail++) {
      candidates.push(`${labels.slice(i, labels.length - tail).join('.')}.*`);
    }
  }
  const excepted = new Set();
  for (const c of candidates) for (const k of table.exceptions[c] || []) excepted.add(k);
  if (excepted.has('')) return [];
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    for (const entry of table.hosts[c] || []) {
      const key = JSON.stringify(entry);
      if (!excepted.has(key) && !seen.has(key)) {
        seen.add(key);
        out.push(entry);
      }
    }
  }
  return out;
}

/** Выполняет скриптлеты. entries: [[canonicalName, ...args], ...] */
export function runScriptlets(entries) {
  'use strict';
  const win = window;
  const doc = document;
  const { defineProperty, getOwnPropertyDescriptor, keys } = Object;
  const fnToString = Function.prototype.toString;
  const magic = `br${Math.random().toString(36).slice(2)}`;
  const NOPE = {};

  const isObjectLike = (v) => (typeof v === 'object' && v !== null) || typeof v === 'function';
  const describe = (fn) => {
    if (typeof fn !== 'function') return String(fn);
    try {
      return fnToString.call(fn);
    } catch {
      return '';
    }
  };
  const absUrl = (u) => {
    try {
      return new URL(String(u), doc.baseURI).href;
    } catch {
      return String(u);
    }
  };
  const splitPipes = (s) => String(s || '').split(/\s*\|\s*/).filter(Boolean);
  const splitSpaces = (s) => String(s || '').split(/\s+/).filter(Boolean);

  let silencer = false;
  function silenceAbortErrors() {
    if (silencer) return;
    silencer = true;
    win.addEventListener('error', (e) => {
      if (String(e.message || '').includes(magic)) e.preventDefault();
    }, true);
  }
  function throwMagic() {
    throw new ReferenceError(magic);
  }

  /** Строка-шаблон uBO: подстрока, /regex/flags, «!» в начале — отрицание, пусто или * — всё. */
  function toMatcher(pattern) {
    let p = pattern == null ? '' : String(pattern);
    let negate = false;
    if (p.startsWith('!')) {
      negate = true;
      p = p.slice(1);
    }
    let test;
    const rx = /^\/(.+)\/([dgimsuy]*)$/.exec(p);
    if (p === '' || p === '*') test = () => true;
    else if (rx) {
      let re = null;
      try {
        re = new RegExp(rx[1], rx[2].replace(/[gy]/g, ''));
      } catch {
        re = null;
      }
      test = re ? (s) => re.test(String(s)) : () => false;
    } else test = (s) => String(s).includes(p);
    return negate ? (s) => !test(s) : test;
  }

  function delayMatcher(raw) {
    if (raw == null || raw === '' || raw === '*') return () => true;
    let s = String(raw);
    const neg = s.startsWith('!');
    if (neg) s = s.slice(1);
    const d = parseInt(s, 10);
    if (!Number.isFinite(d)) return () => true;
    return neg ? (x) => x !== d : (x) => x === d;
  }

  /** Доходит по цепочке `a.b.c` до владельца последнего свойства; ждёт появления промежуточных объектов. */
  function trapChain(owner, chain, onLeaf) {
    const dot = chain.indexOf('.');
    if (dot === -1) {
      onLeaf(owner, chain);
      return;
    }
    const prop = chain.slice(0, dot);
    const rest = chain.slice(dot + 1);
    let current;
    try {
      current = owner[prop];
    } catch {
      return;
    }
    if (isObjectLike(current)) {
      trapChain(current, rest, onLeaf);
      return;
    }
    const desc = getOwnPropertyDescriptor(owner, prop);
    if (desc && desc.configurable === false) return;
    let value = current;
    defineProperty(owner, prop, {
      configurable: true,
      enumerable: true,
      get() { return value; },
      set(v) {
        value = v;
        if (isObjectLike(v)) trapChain(v, rest, onLeaf);
      },
    });
  }

  /** Оборачивает свойство: при условии shouldAbort() чтение и запись бросают исключение. */
  function wrapAbort(owner, prop, shouldAbort) {
    const desc = getOwnPropertyDescriptor(owner, prop);
    if (desc && desc.configurable === false) return;
    let value = desc ? desc.value : owner[prop];
    const getter = desc && desc.get;
    const setter = desc && desc.set;
    defineProperty(owner, prop, {
      configurable: true,
      enumerable: desc ? desc.enumerable : true,
      get() {
        if (shouldAbort()) throwMagic();
        return getter ? getter.call(this) : value;
      },
      set(v) {
        if (shouldAbort()) throwMagic();
        if (setter) setter.call(this, v);
        else value = v;
      },
    });
  }

  function constantValue(raw) {
    if (raw === undefined) return NOPE;
    const r = String(raw).trim();
    switch (r) {
      case 'undefined': return undefined;
      case 'false': return false;
      case 'true': return true;
      case 'null': return null;
      case "''": case '""': case '': case 'emptyStr': return '';
      case 'noopFunc': return function () {};
      case 'trueFunc': return function () { return true; };
      case 'falseFunc': return function () { return false; };
      case 'throwFunc': return function () { throwMagic(); };
      case 'emptyArr': case '[]': return [];
      case 'emptyObj': case '{}': return {};
      case 'yes': case 'no': return r;
      default:
        if (/^-?\d+$/.test(r) && Math.abs(Number(r)) <= 0x7fff) return Number(r);
        return NOPE;
    }
  }

  function defuseTimer(name, needle, delay) {
    if ((needle == null || needle === '') && (delay == null || delay === '')) return;
    const matchFn = toMatcher(needle);
    const matchDelay = delayMatcher(delay);
    win[name] = new Proxy(win[name], {
      apply(target, self, args) {
        if (matchFn(describe(args[0])) && matchDelay(Number(args[1]) || 0)) args[0] = function () {};
        return Reflect.apply(target, self, args);
      },
    });
  }

  function boostTimer(name, needle, delay, boost) {
    const matchFn = toMatcher(needle);
    const wanted = delay === '*' ? null : parseInt(delay, 10) || 1000;
    let factor = parseFloat(boost);
    if (!Number.isFinite(factor)) factor = 0.05;
    factor = Math.min(50, Math.max(0.001, factor));
    win[name] = new Proxy(win[name], {
      apply(target, self, args) {
        const ms = Number(args[1]) || 0;
        if ((wanted === null || ms === wanted) && matchFn(describe(args[0]))) args[1] = ms * factor;
        return Reflect.apply(target, self, args);
      },
    });
  }

  function deletePath(obj, parts, i) {
    if (!isObjectLike(obj)) return;
    const key = parts[i];
    const last = i === parts.length - 1;
    if (key === '[]' || key === '*') {
      for (const k of keys(obj)) {
        if (last) delete obj[k];
        else deletePath(obj[k], parts, i + 1);
      }
      return;
    }
    if (!(key in obj)) return;
    if (last) delete obj[key];
    else deletePath(obj[key], parts, i + 1);
  }

  function hasPath(obj, parts, i) {
    if (i === parts.length) return true;
    if (!isObjectLike(obj)) return false;
    const key = parts[i];
    if (key === '[]' || key === '*') return keys(obj).some((k) => hasPath(obj[k], parts, i + 1));
    return key in obj && hasPath(obj[key], parts, i + 1);
  }

  const REQUEST_PROPS = ['url', 'method', 'body', 'mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive'];
  /** `ads` → адрес содержит «ads»; `url:/x/ method:POST` — условия по полям запроса. */
  function propsMatcher(raw) {
    const tokens = splitSpaces(raw);
    if (!tokens.length) return null;
    const conditions = tokens.map((token) => {
      const i = token.indexOf(':');
      const key = i > 0 ? token.slice(0, i) : '';
      return REQUEST_PROPS.includes(key) ? [key, toMatcher(token.slice(i + 1))] : ['url', toMatcher(token)];
    });
    return (props) => conditions.every(([k, m]) => m(props[k] == null ? '' : String(props[k])));
  }

  function responseBody(raw) {
    if (raw === 'emptyObj') return '{}';
    if (raw === 'emptyArr') return '[]';
    return '';
  }

  function onDomChanges(run, behavior) {
    const b = String(behavior || '');
    const safeRun = () => {
      try {
        run();
      } catch {
        // неверный селектор — просто пропускаем
      }
    };
    if (b.includes('asap')) safeRun();
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', safeRun, { once: true });
    else safeRun();
    if (b.includes('complete')) win.addEventListener('load', safeRun, { once: true });
    if (b.includes('stay')) {
      let timer = 0;
      const observer = new MutationObserver(() => {
        timer ||= setTimeout(() => {
          timer = 0;
          safeRun();
        }, 50);
      });
      const start = () => observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
      if (doc.documentElement) start();
      else doc.addEventListener('DOMContentLoaded', start, { once: true });
    }
  }

  function setStorageItem(storageName, key, raw) {
    if (!key) return;
    let storage;
    try {
      storage = win[storageName];
    } catch {
      return;
    }
    const r = raw == null ? '' : String(raw);
    const ALLOWED = ['undefined', 'false', 'true', 'null', '', 'yes', 'no', 'on', 'off', 'accept', 'accepted', 'reject', 'rejected', 'allowed', 'denied'];
    let value;
    if (r === '$remove$') {
      storage.removeItem(key);
      return;
    }
    if (r === 'emptyArr') value = '[]';
    else if (r === 'emptyObj') value = '{}';
    else if (ALLOWED.includes(r)) value = r;
    else if (/^\d+$/.test(r) && Number(r) <= 0x7fff) value = r;
    else return;
    storage.setItem(key, value);
  }

  function defuseDetectors() {
    function Detector() {}
    const later = (fn) => {
      if (typeof fn === 'function') setTimeout(fn, 1);
    };
    Object.assign(Detector.prototype, {
      check() { return true; },
      clearEvent() {},
      emitEvent() { return this; },
      on(detected, fn) {
        if (!detected) later(fn);
        return this;
      },
      onDetected() { return this; },
      onNotDetected(fn) {
        later(fn);
        return this;
      },
      setOption() { return this; },
      options: { set() {}, get() {} },
    });
    const instance = new Detector();
    for (const name of ['FuckAdBlock', 'BlockAdBlock', 'SniffAdBlock']) win[name] = Detector;
    for (const name of ['fuckAdBlock', 'blockAdBlock', 'sniffAdBlock']) win[name] = instance;
  }

  const S = {
    'set-constant'(chain, raw) {
      const value = constantValue(raw);
      if (!chain || value === NOPE) return;
      trapChain(win, chain, (owner, prop) => {
        const desc = getOwnPropertyDescriptor(owner, prop);
        if (desc && desc.configurable === false) {
          try {
            owner[prop] = value;
          } catch {
            // только для чтения
          }
          return;
        }
        defineProperty(owner, prop, { configurable: true, enumerable: desc ? desc.enumerable : true, get: () => value, set() {} });
      });
    },

    'abort-on-property-read'(chain) {
      if (!chain) return;
      silenceAbortErrors();
      trapChain(win, chain, (owner, prop) => {
        const desc = getOwnPropertyDescriptor(owner, prop);
        if (desc && desc.configurable === false) return;
        defineProperty(owner, prop, { configurable: true, get: throwMagic, set() {} });
      });
    },

    'abort-on-property-write'(chain) {
      if (!chain) return;
      silenceAbortErrors();
      trapChain(win, chain, (owner, prop) => {
        const desc = getOwnPropertyDescriptor(owner, prop);
        if (desc && desc.configurable === false) return;
        defineProperty(owner, prop, { configurable: true, get: () => undefined, set: throwMagic });
      });
    },

    'abort-current-script'(chain, needle, context) {
      if (!chain) return;
      silenceAbortErrors();
      const matchText = toMatcher(needle);
      const matchContext = context ? toMatcher(context) : null;
      const shouldAbort = () => {
        const script = doc.currentScript;
        if (!(script instanceof HTMLScriptElement)) return false;
        if (matchContext && !matchContext(script.src || 'inlineScript')) return false;
        return matchText(script.textContent || script.src || '');
      };
      trapChain(win, chain, (owner, prop) => wrapAbort(owner, prop, shouldAbort));
    },

    'abort-on-stack-trace'(chain, needle) {
      if (!chain || !needle) return;
      silenceAbortErrors();
      const matchStack = toMatcher(needle);
      trapChain(win, chain, (owner, prop) => wrapAbort(owner, prop, () => matchStack(new Error().stack || '')));
    },

    'no-setTimeout-if'(needle, delay) { defuseTimer('setTimeout', needle, delay); },
    'no-setInterval-if'(needle, delay) { defuseTimer('setInterval', needle, delay); },
    'nano-setTimeout-booster'(needle, delay, boost) { boostTimer('setTimeout', needle, delay, boost); },
    'nano-setInterval-booster'(needle, delay, boost) { boostTimer('setInterval', needle, delay, boost); },

    'addEventListener-defuser'(type, needle) {
      if (!type && !needle) return;
      const matchType = toMatcher(type);
      const matchFn = toMatcher(needle);
      const proto = win.EventTarget.prototype;
      proto.addEventListener = new Proxy(proto.addEventListener, {
        apply(target, self, args) {
          const handler = args[1];
          let text = '';
          try {
            text = handler && typeof handler === 'object' && typeof handler.handleEvent === 'function'
              ? describe(handler.handleEvent)
              : describe(handler);
          } catch {
            text = '';
          }
          if (matchType(String(args[0])) && matchFn(text)) return undefined;
          return Reflect.apply(target, self, args);
        },
      });
    },

    'json-prune'(rawPrune, rawNeedle) {
      const prunePaths = splitSpaces(rawPrune).map((p) => p.split('.'));
      if (!prunePaths.length) return;
      const needPaths = splitSpaces(rawNeedle).map((p) => p.split('.'));
      const prune = (obj) => {
        try {
          if (!isObjectLike(obj)) return obj;
          if (needPaths.length && !needPaths.every((p) => hasPath(obj, p, 0))) return obj;
          for (const p of prunePaths) deletePath(obj, p, 0);
        } catch {
          // не мешаем странице
        }
        return obj;
      };
      JSON.parse = new Proxy(JSON.parse, { apply: (t, self, args) => prune(Reflect.apply(t, self, args)) });
      const proto = win.Response.prototype;
      proto.json = new Proxy(proto.json, { apply: (t, self, args) => Reflect.apply(t, self, args).then(prune) });
    },

    'remove-attr'(rawAttrs, rawSelector, behavior) {
      const attrs = splitPipes(rawAttrs);
      if (!attrs.length) return;
      const selector = rawSelector || attrs.map((a) => `[${CSS.escape(a)}]`).join(',');
      onDomChanges(() => {
        for (const el of doc.querySelectorAll(selector)) for (const a of attrs) el.removeAttribute(a);
      }, behavior);
    },

    'remove-class'(rawClasses, rawSelector, behavior) {
      const classes = splitPipes(rawClasses);
      if (!classes.length) return;
      const selector = rawSelector || classes.map((c) => `.${CSS.escape(c)}`).join(',');
      onDomChanges(() => {
        for (const el of doc.querySelectorAll(selector)) el.classList.remove(...classes);
      }, behavior);
    },

    'no-fetch-if'(rawProps, rawBody) {
      const match = propsMatcher(rawProps);
      if (!match) return;
      const body = responseBody(rawBody);
      win.fetch = new Proxy(win.fetch, {
        apply(target, self, args) {
          const [input, init] = args;
          const props = { url: '', method: 'GET' };
          try {
            if (input instanceof win.Request) for (const k of REQUEST_PROPS) props[k] = input[k];
            else props.url = absUrl(input);
            if (init && typeof init === 'object') for (const k of REQUEST_PROPS) if (k in init) props[k] = init[k];
          } catch {
            // странный аргумент — сравним как есть
          }
          if (!match(props)) return Reflect.apply(target, self, args);
          const response = new win.Response(body, { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/plain' } });
          try {
            defineProperty(response, 'url', { value: props.url });
          } catch {
            // не критично
          }
          return Promise.resolve(response);
        },
      });
    },

    'no-xhr-if'(rawProps, rawBody) {
      const match = propsMatcher(rawProps);
      if (!match) return;
      const body = responseBody(rawBody);
      const proto = win.XMLHttpRequest.prototype;
      const flagged = new WeakMap();
      proto.open = new Proxy(proto.open, {
        apply(target, xhr, args) {
          const props = { method: String(args[0] || 'GET'), url: absUrl(args[1]) };
          if (match(props)) flagged.set(xhr, props);
          else flagged.delete(xhr);
          return Reflect.apply(target, xhr, args);
        },
      });
      proto.send = new Proxy(proto.send, {
        apply(target, xhr, args) {
          const props = flagged.get(xhr);
          if (!props) return Reflect.apply(target, xhr, args);
          const type = xhr.responseType;
          let response = body;
          if (type === 'json') {
            try {
              response = JSON.parse(body || 'null');
            } catch {
              response = null;
            }
          } else if (type === 'arraybuffer') response = new ArrayBuffer(0);
          else if (type === 'blob') response = new Blob([body]);
          else if (type === 'document') response = null;
          const set = (k, v) => defineProperty(xhr, k, { value: v, configurable: true });
          set('readyState', 4);
          set('status', 200);
          set('statusText', 'OK');
          set('responseURL', props.url);
          set('response', response);
          if (type === '' || type === 'text') set('responseText', body);
          setTimeout(() => {
            for (const t of ['readystatechange', 'load', 'loadend']) xhr.dispatchEvent(new Event(t));
          }, 1);
          return undefined;
        },
      });
    },

    'no-window-open-if'(needle, delay) {
      let pattern = needle;
      // старый синтаксис AdGuard: prevent-window-open('0'|'1', 'шаблон')
      if ((needle === '0' || needle === '1') && delay && !/^\d+$/.test(delay)) pattern = (needle === '0' ? '!' : '') + delay;
      const match = toMatcher(pattern);
      win.open = new Proxy(win.open, {
        apply(target, self, args) {
          const url = args.length && args[0] != null ? String(args[0]) : '';
          if (match(url)) return null;
          return Reflect.apply(target, self, args);
        },
      });
    },

    'noeval-if'(needle) {
      const match = toMatcher(needle);
      win.eval = new Proxy(win.eval, {
        apply(target, self, args) {
          if (match(String(args[0]))) return undefined;
          return Reflect.apply(target, self, args);
        },
      });
    },

    'set-local-storage-item'(key, value) { setStorageItem('localStorage', key, value); },
    'set-session-storage-item'(key, value) { setStorageItem('sessionStorage', key, value); },

    'remove-node-text'(nodeName, needle) {
      if (!nodeName || !needle) return;
      const name = String(nodeName).toLowerCase();
      const matchName = name.startsWith('/') ? toMatcher(nodeName) : (n) => n === name;
      const matchText = toMatcher(needle);
      const check = (node) => {
        if (node.nodeType === 1) {
          if (matchName(node.nodeName.toLowerCase()) && matchText(node.textContent)) node.textContent = '';
        } else if (node.nodeType === 3) {
          if (name === '#text') {
            if (matchText(node.data)) node.data = '';
          } else {
            const parent = node.parentNode;
            if (parent && parent.nodeType === 1 && matchName(parent.nodeName.toLowerCase()) && matchText(parent.textContent)) parent.textContent = '';
          }
        }
      };
      new MutationObserver((mutations) => {
        for (const m of mutations) for (const n of m.addedNodes) check(n);
      }).observe(doc, { childList: true, subtree: true });
      if (doc.documentElement && /^[a-z][a-z0-9-]*$/.test(name)) for (const el of doc.querySelectorAll(name)) check(el);
    },

    'nobab'() { defuseDetectors(); },
    'nofab'() { defuseDetectors(); },
  };

  for (const entry of entries) {
    const [name, ...args] = entry;
    const scriptlet = S[name];
    if (!scriptlet) continue;
    try {
      scriptlet(...args);
    } catch {
      // один сломанный скриптлет не должен мешать остальным
    }
  }
}
