/**
 * Break Reklams — парсер фильтров в синтаксисе Adblock Plus / uBlock Origin и компилятор:
 *   сетевые фильтры   → правила chrome.declarativeNetRequest (DNR)
 *   косметические     → данные для скрытия элементов (CSS-селекторы)
 *
 * Модуль без зависимостей: его используют и сборщик (Node), и расширение
 * (service worker компилирует «Мои фильтры» пользователя).
 */

import { normalizeScriptletName } from './scriptlets.js';

/** Правила-исключения (allow / allowAllRequests) получают id начиная с этого числа. */
export const ALLOW_ID_BASE = 10_000_000;

export const PRIORITY = Object.freeze({
  block: 1,
  neuter: 2, // вместо ошибки — пустой ответ (детектор думает, что реклама загрузилась)
  redirect: 3,
  allow: 4,
  importantBlock: 5,
  importantRedirect: 6,
  allowlist: 100,
});

/** Чем заменять запросы к рекламным доменам: успешный пустой ответ вместо ошибки. */
const NEUTER = [
  { types: ['script'], file: 'noop.js' },
  { types: ['image'], file: '1x1.gif' },
  { types: ['xmlhttprequest'], file: 'noop.txt' },
  { types: ['sub_frame'], file: 'noop.html' },
];

// Типы, общие для Chrome и Firefox (webtransport/webbundle Firefox не знает — правило бы отклонилось).
const ALL_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other',
];

const TYPE_MAP = {
  script: ['script'],
  image: ['image'], img: ['image'],
  stylesheet: ['stylesheet'], css: ['stylesheet'],
  object: ['object'], 'object-subrequest': ['object'],
  xmlhttprequest: ['xmlhttprequest'], xhr: ['xmlhttprequest'],
  subdocument: ['sub_frame'], frame: ['sub_frame'],
  ping: ['ping'], beacon: ['ping'],
  media: ['media'],
  font: ['font'],
  websocket: ['websocket'],
  other: ['other'],
};

const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other']);

/** Имена ресурсов для $redirect= → файлы в extension/resources/. */
export const REDIRECT_RESOURCES = Object.freeze({
  'noop.js': 'noop.js',
  'noopjs': 'noop.js',
  'noop.txt': 'noop.txt',
  'nooptext': 'noop.txt',
  'noop.html': 'noop.html',
  'noopframe': 'noop.html',
  'noop.css': 'noop.css',
  'noopcss': 'noop.css',
  '1x1.gif': '1x1.gif',
  '1x1-transparent.gif': '1x1.gif',
  'googlesyndication_adsbygoogle.js': 'googlesyndication_adsbygoogle.js',
  'googlesyndication.com/adsbygoogle.js': 'googlesyndication_adsbygoogle.js',
  'googletagservices_gpt.js': 'googletagservices_gpt.js',
  'googletagservices.com/gpt.js': 'googletagservices_gpt.js',
  'google-analytics_analytics.js': 'google-analytics_analytics.js',
  'google-analytics.com/analytics.js': 'google-analytics_analytics.js',
  'googletagmanager_gtm.js': 'googletagmanager_gtm.js',
  'googletagmanager.com/gtm.js': 'googletagmanager_gtm.js',
  'nofab.js': 'nofab.js',
  'fuckadblock.js-3.2.0': 'nofab.js',
  'nobab.js': 'nofab.js',
});

export const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const LOOSE_HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const ENTITY_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.\*$/;
const OPTIONS_RE = /^~?[\w-]+(?:=[^,]*)?(?:,~?[\w-]+(?:=[^,]*)?)*$/;
const COSMETIC_RE = /^([^\s/|"'`]*?)(#@?#|#@?\?#|#@?\$\??#|#@?%#|\$@?\$)(.*)$/;
const HOSTS_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+([^\s#]+)/;
const PROCEDURAL_RE = /:(?:-abp-[\w-]+|has-text|contains|xpath|upward|matches-(?:css(?:-before|-after)?|attr|path|media|prop)|min-text-length|nth-ancestor|watch-attr|remove-attr|remove-class|others|if-not|if|shadow|properties|spath)\(/;
const STYLE_SUFFIX_RE = /^(.*?):style\((.*)\)$/;

// ─── хосты ───────────────────────────────────────────────────────────────────

/** Приводит хост к ASCII (punycode) в нижнем регистре. null — если хост некорректен. */
export function toAsciiHost(input) {
  const host = String(input).trim().toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (LOOSE_HOST_RE.test(host)) return host;
  try {
    const h = new URL(`http://${host}/`).hostname;
    return LOOSE_HOST_RE.test(h) ? h : null;
  } catch {
    return null;
  }
}

/** Разбирает `a.com|~b.com` из опций domain=/to=. null — если после разбора фильтр стал бы шире задуманного. */
function parseDomainOption(value) {
  const include = [];
  const exclude = [];
  let droppedInclude = false;
  for (let d of value.split('|')) {
    d = d.trim();
    if (!d) continue;
    const neg = d.startsWith('~');
    if (neg) d = d.slice(1);
    const host = d.includes('*') || d.startsWith('/') ? null : toAsciiHost(d);
    if (!host) {
      if (!neg) droppedInclude = true;
      continue;
    }
    (neg ? exclude : include).push(host);
  }
  if (droppedInclude && include.length === 0) return null;
  return { include, exclude };
}

/** Разбирает `a.com,~b.com,google.*` из начала косметического фильтра. */
function parseCosmeticDomains(str) {
  const include = [];
  const exclude = [];
  if (!str) return { include, exclude };
  let droppedInclude = false;
  for (let d of str.split(',')) {
    d = d.trim().toLowerCase();
    if (!d) continue;
    const neg = d.startsWith('~');
    if (neg) d = d.slice(1);
    const host = ENTITY_RE.test(d) ? d : toAsciiHost(d);
    if (!host) {
      if (!neg) droppedInclude = true;
      continue;
    }
    (neg ? exclude : include).push(host);
  }
  if (droppedInclude && include.length === 0) return null;
  return { include, exclude };
}

// ─── разбор строк ────────────────────────────────────────────────────────────

const unsupported = (reason) => ({ kind: 'unsupported', reason });

function isComment(line) {
  return line.startsWith('!') || line.startsWith('[') || /^#(?![#@?$%])/.test(line);
}

/** Возвращает фильтр без опции badfilter, если она есть. */
function stripBadfilter(line) {
  const i = line.lastIndexOf('$');
  if (i === -1) return null;
  const tail = line.slice(i + 1);
  if (!OPTIONS_RE.test(tail)) return null;
  const opts = tail.split(',');
  const rest = opts.filter((o) => o.toLowerCase() !== 'badfilter');
  if (rest.length === opts.length) return null;
  return line.slice(0, i) + (rest.length ? `$${rest.join(',')}` : '');
}

function isSafeStyle(css) {
  return css.length < 500 && !/[{}<>\\]|url\s*\(|expression\s*\(|@import|javascript:/i.test(css);
}

/** Аргументы `+js(name, a, b)`: запятая экранируется `\,`, аргумент можно взять в кавычки. */
export function splitScriptletArgs(inner) {
  const out = [];
  let cur = '';
  let quote = '';
  let atStart = true;
  const finish = (s) => {
    const t = s.trim();
    const q = t[0];
    if (t.length >= 2 && (q === '"' || q === "'" || q === '`') && t.endsWith(q)) return t.slice(1, -1).split(`\\${q}`).join(q);
    return t;
  };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (atStart && c === ' ') continue;
    if (atStart && (c === '"' || c === "'" || c === '`')) {
      quote = c;
      atStart = false;
      cur = c;
      continue;
    }
    atStart = false;
    if (c === '\\' && inner[i + 1] === ',') {
      cur += ',';
      i++;
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote && inner[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === ',') {
      out.push(finish(cur));
      cur = '';
      atStart = true;
      continue;
    }
    cur += c;
  }
  out.push(finish(cur));
  return out;
}

/** Аргументы AdGuard: `//scriptlet('name', 'a', "b")`. */
function parseAdguardScriptlet(body) {
  const m = /^\/\/scriptlet\((.*)\)\s*$/.exec(body.trim());
  if (!m) return null;
  const args = [];
  const re = /\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*(?:,|$)/y;
  const s = m[1];
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const r = re.exec(s);
    if (!r) return null;
    args.push(r[2].replace(/\\(.)/g, '$1'));
    pos = re.lastIndex;
  }
  return args;
}

function parseScriptlet(domains, exception, args) {
  if (!args) return unsupported('scriptlet');
  const doms = parseCosmeticDomains(domains);
  if (!doms) return unsupported('domain');
  const [rawName = '', ...rest] = args;
  if (!rawName) {
    // example.com#@#+js() — отключить все скриптлеты на сайте
    return exception ? { kind: 'scriptlet', exception, name: '', args: [], include: doms.include, exclude: doms.exclude } : unsupported('scriptlet');
  }
  const name = normalizeScriptletName(rawName);
  if (!name) return unsupported(`scriptlet:${rawName.replace(/\.js$/, '')}`);
  return { kind: 'scriptlet', exception, name, args: rest, include: doms.include, exclude: doms.exclude };
}

function parseCosmetic(domains, separator, rawBody) {
  const exception = separator.includes('@');
  if (separator.includes('%')) return parseScriptlet(domains, exception, parseAdguardScriptlet(rawBody));
  if (separator.includes('$')) return unsupported('snippet');
  let body = rawBody.trim();
  if (!body) return unsupported('empty');
  if (body.startsWith('+js(') && body.endsWith(')')) return parseScriptlet(domains, exception, splitScriptletArgs(body.slice(4, -1)));
  if (body.startsWith('+') || body.startsWith('^')) return unsupported('scriptlet');
  body = body.replace(/:-abp-has\(/g, ':has(');

  let style = null;
  const sm = STYLE_SUFFIX_RE.exec(body);
  if (sm) {
    body = sm[1].trim();
    style = sm[2].trim();
    if (!style || !isSafeStyle(style)) return unsupported('style');
  } else if (body.endsWith(':remove()')) {
    body = body.slice(0, -':remove()'.length).trim();
  }
  if (!body || body.length > 2000 || PROCEDURAL_RE.test(body) || /[{}<]|\/\*|^@/.test(body)) {
    return unsupported('procedural');
  }

  const doms = parseCosmeticDomains(domains);
  if (!doms) return unsupported('domain');
  return {
    kind: 'cosmetic',
    exception,
    body: style ? `${body}:style(${style})` : body,
    include: doms.include,
    exclude: doms.exclude,
  };
}

function parseNetwork(input) {
  let line = input;
  let exception = false;
  if (line.startsWith('@@')) {
    exception = true;
    line = line.slice(2);
  }

  let pattern = line;
  let opts = [];
  const dollar = line.lastIndexOf('$');
  if (dollar !== -1) {
    const tail = line.slice(dollar + 1);
    if (OPTIONS_RE.test(tail)) {
      pattern = line.slice(0, dollar);
      opts = tail.split(',');
    }
  }
  if (pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/')) return unsupported('regex');

  const f = {
    kind: 'network',
    exception,
    urlFilter: '',
    domainHost: null,
    types: new Set(),
    notTypes: new Set(),
    initiatorDomains: [],
    excludedInitiatorDomains: [],
    requestDomains: [],
    excludedRequestDomains: [],
    methods: [],
    notMethods: [],
    party: null,
    matchCase: false,
    important: false,
    redirect: null,
    redirectRule: false,
    popup: false,
    document: false,
    cosmetic: null,
  };

  for (const rawOpt of opts) {
    const eq = rawOpt.indexOf('=');
    let name = (eq === -1 ? rawOpt : rawOpt.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? '' : rawOpt.slice(eq + 1);
    const neg = name.startsWith('~');
    if (neg) name = name.slice(1);

    switch (name) {
      case 'third-party': case '3p': case 'strict3p':
        f.party = neg ? 'firstParty' : 'thirdParty';
        break;
      case 'first-party': case '1p': case 'strict1p':
        f.party = neg ? 'thirdParty' : 'firstParty';
        break;
      case 'domain': case 'from': {
        const r = parseDomainOption(value);
        if (!r) return unsupported('domain');
        f.initiatorDomains.push(...r.include);
        f.excludedInitiatorDomains.push(...r.exclude);
        break;
      }
      case 'to': {
        const r = parseDomainOption(value);
        if (!r) return unsupported('to');
        f.requestDomains.push(...r.include);
        f.excludedRequestDomains.push(...r.exclude);
        break;
      }
      case 'denyallow': {
        const r = parseDomainOption(value);
        if (!r) return unsupported('denyallow');
        f.excludedRequestDomains.push(...r.include);
        break;
      }
      case 'match-case':
        f.matchCase = !neg;
        break;
      case 'important':
        f.important = true;
        break;
      case 'popup':
        if (!neg) {
          f.popup = true;
          f.types.add('main_frame');
        }
        break;
      case 'document': case 'doc':
        if (neg) f.notTypes.add('main_frame');
        else {
          f.document = true;
          f.types.add('main_frame');
        }
        break;
      case 'all':
        for (const t of ALL_TYPES) f.types.add(t);
        f.document = true;
        break;
      case 'redirect': case 'redirect-rule':
        f.redirect = value.split(':')[0];
        f.redirectRule = name === 'redirect-rule';
        break;
      case 'empty': case 'mp4': case 'collapse':
        break;
      case 'elemhide': case 'ehide':
        f.cosmetic = 'all';
        break;
      case 'generichide': case 'ghide':
        f.cosmetic = 'generic';
        break;
      case 'specifichide': case 'shide':
        f.cosmetic = 'specific';
        break;
      case 'method':
        for (let m of value.toLowerCase().split('|')) {
          const mneg = m.startsWith('~');
          if (mneg) m = m.slice(1);
          if (!METHODS.has(m)) return unsupported('method');
          (mneg ? f.notMethods : f.methods).push(m);
        }
        break;
      default:
        if (TYPE_MAP[name]) {
          for (const t of TYPE_MAP[name]) (neg ? f.notTypes : f.types).add(t);
          break;
        }
        return unsupported(`option:${name}`);
    }
  }

  // @@||site^$generichide и т. п. — это директивы для косметики, а не сетевые правила
  if (f.cosmetic) {
    if (!exception) return unsupported('cosmetic-option');
    const hm = /^\|\|([a-z0-9.-]+)\^?\|?$/i.exec(pattern.trim());
    const hosts = hm ? [hm[1].toLowerCase()] : f.initiatorDomains;
    if (!hosts.length) return unsupported('directive');
    return { kind: 'directive', mode: f.cosmetic, hosts };
  }

  // нормализация шаблона
  let p = pattern.trim();
  if (!f.matchCase) p = p.toLowerCase();
  p = p.replace(/^\*+/, '').replace(/\*+$/, '');
  // ||пример.рф^ → ||xn--e1afmkfd.xn--p1ai^
  p = p.replace(/^\|\|([^/^:?*|]+)/, (m, host) => (/[^\x21-\x7e]/.test(host) ? `||${toAsciiHost(host) ?? host}` : m));
  if (p === '|' || p === '||') p = '';
  if (p && /[^\x21-\x7e]/.test(p)) return unsupported('non-ascii');
  if (p.startsWith('||*') || p.startsWith('|*')) return unsupported('pattern');
  const core = p.replace(/^\|\|?/, '').replace(/\|$/, '');
  if (core.includes('|')) return unsupported('pattern');
  const dm = /^\|\|([a-z0-9.-]+)\^\|?$/.exec(p);
  if (dm && HOST_RE.test(dm[1])) f.domainHost = dm[1];
  f.urlFilter = p;

  // типы ресурсов
  const types = new Set(f.types);
  for (const t of f.notTypes) types.delete(t);
  if (!exception && types.has('main_frame')) {
    // Блокировать целые страницы можно только для конкретного домена,
    // иначе широкий $popup-фильтр сломает обычные переходы по ссылкам.
    const targeted = /^\|\|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/^:?]|$)/.test(p);
    if (!targeted) {
      types.delete('main_frame');
      f.document = false;
    }
  }
  if (f.types.size && !types.size) return unsupported('types');
  f.resolvedTypes = types;

  if (!f.urlFilter && !f.initiatorDomains.length && !f.requestDomains.length) return unsupported('too-broad');
  return f;
}

/** Разбирает одну строку фильтра. Возвращает null для пустых строк и комментариев. */
export function parseLine(input) {
  let line = String(input).trim();
  if (!line || isComment(line)) return null;
  const hm = HOSTS_RE.exec(line);
  if (hm) {
    const host = toAsciiHost(hm[1]);
    if (!host || !HOST_RE.test(host)) return unsupported('hosts');
    line = `||${host}^`;
  }
  const cm = COSMETIC_RE.exec(line);
  if (cm) return parseCosmetic(cm[1], cm[2], cm[3]);
  return parseNetwork(line);
}

/**
 * Разбирает весь список фильтров.
 * @returns {{network: object[], cosmetic: object[], directives: object[], total: number, unsupported: number, reasons: Record<string, number>, rejected: {line: string, reason: string}[]}}
 */
export function parseFilterList(text, { keepRejected = 0 } = {}) {
  const lines = String(text).split(/\r?\n/);
  const bad = new Set();
  for (const raw of lines) {
    if (!raw.includes('badfilter')) continue;
    const stripped = stripBadfilter(raw.trim());
    if (stripped) bad.add(stripped);
  }

  const out = { network: [], cosmetic: [], directives: [], scriptlets: [], total: 0, unsupported: 0, reasons: {}, rejected: [] };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || isComment(line)) continue;
    out.total++;
    if (bad.has(line) || (line.includes('badfilter') && stripBadfilter(line))) continue;
    const f = parseLine(line);
    if (!f) continue;
    if (f.kind === 'network') out.network.push(f);
    else if (f.kind === 'cosmetic') out.cosmetic.push(f);
    else if (f.kind === 'directive') out.directives.push(f);
    else if (f.kind === 'scriptlet') out.scriptlets.push(f);
    else {
      out.unsupported++;
      out.reasons[f.reason] = (out.reasons[f.reason] || 0) + 1;
      if (out.rejected.length < keepRejected) out.rejected.push({ line, reason: f.reason });
    }
  }
  return out;
}

// ─── сетевые фильтры → DNR ───────────────────────────────────────────────────

const uniq = (arr) => [...new Set(arr)];
const orderTypes = (set) => ALL_TYPES.filter((t) => set.has(t));

function buildRule(f, resources, resourcesDir) {
  const condition = {};
  const groupHost = f.domainHost && !f.requestDomains.length && !f.matchCase ? f.domainHost : null;
  if (!groupHost && f.urlFilter) condition.urlFilter = f.urlFilter;
  if (f.matchCase && condition.urlFilter) condition.isUrlFilterCaseSensitive = true;
  if (f.initiatorDomains.length) condition.initiatorDomains = uniq(f.initiatorDomains);
  if (f.excludedInitiatorDomains.length) condition.excludedInitiatorDomains = uniq(f.excludedInitiatorDomains);
  if (f.requestDomains.length) condition.requestDomains = uniq(f.requestDomains);
  if (f.excludedRequestDomains.length) condition.excludedRequestDomains = uniq(f.excludedRequestDomains);
  if (f.methods.length) condition.requestMethods = uniq(f.methods);
  else if (f.notMethods.length) condition.excludedRequestMethods = uniq(f.notMethods);
  if (f.party) condition.domainType = f.party;

  let action;
  let priority;
  if (f.exception && f.document) {
    action = { type: 'allowAllRequests' };
    priority = PRIORITY.allow;
    condition.resourceTypes = ['main_frame', 'sub_frame'];
    return { rule: { priority, action, condition }, groupHost };
  }
  if (f.exception) {
    action = { type: 'allow' };
    priority = PRIORITY.allow;
  } else if (f.redirect) {
    const file = resources[f.redirect];
    if (file) {
      action = { type: 'redirect', redirect: { extensionPath: resourcesDir + file } };
      priority = f.important ? PRIORITY.importantRedirect : PRIORITY.redirect;
    } else if (f.redirectRule) {
      return null;
    } else {
      action = { type: 'block' };
      priority = f.important ? PRIORITY.importantBlock : PRIORITY.block;
    }
  } else {
    action = { type: 'block' };
    priority = f.important ? PRIORITY.importantBlock : PRIORITY.block;
  }

  const types = f.resolvedTypes;
  if (types.size) {
    condition.resourceTypes = orderTypes(types);
  } else if (f.notTypes.size) {
    const excluded = new Set(f.notTypes);
    excluded.add('main_frame');
    condition.excludedResourceTypes = orderTypes(excluded);
  }
  return { rule: { priority, action, condition }, groupHost };
}

function pruneSubdomains(hosts) {
  const out = [];
  for (const h of hosts) {
    let redundant = false;
    for (let i = h.indexOf('.'); i !== -1; i = h.indexOf('.', i + 1)) {
      if (hosts.has(h.slice(i + 1))) {
        redundant = true;
        break;
      }
    }
    if (!redundant) out.push(h);
  }
  return out.sort();
}

/**
 * Компилирует сетевые фильтры в правила DNR.
 * Фильтры вида `||domain^` с одинаковыми опциями сливаются в одно правило
 * с requestDomains — это экономит лимит правил в десятки раз.
 */
export function compileNetwork(filters, options = {}) {
  const {
    resources = REDIRECT_RESOURCES,
    resourcesDir = '/resources/',
    maxRules = Infinity,
    chunkSize = 1000,
    neuter = false,
  } = options;

  const ordered = [];
  const groups = new Map();
  const seen = new Set();
  let invalid = 0;

  for (const f of filters) {
    const built = buildRule(f, resources, resourcesDir);
    if (!built) {
      invalid++;
      continue;
    }
    const key = JSON.stringify(built.rule);
    if (built.groupHost) {
      let g = groups.get(key);
      if (!g) {
        g = { template: built.rule, hosts: new Set() };
        groups.set(key, g);
        ordered.push(g);
      }
      g.hosts.add(built.groupHost);
    } else if (!seen.has(key)) {
      seen.add(key);
      ordered.push({ rule: built.rule });
    }
  }

  const rules = [];
  let dropped = 0;
  let nextBlock = 1;
  let nextAllow = ALLOW_ID_BASE + 1;
  const push = (rule) => {
    if (rules.length >= maxRules) {
      dropped++;
      return;
    }
    const allowish = rule.action.type === 'allow' || rule.action.type === 'allowAllRequests';
    rules.push({ id: allowish ? nextAllow++ : nextBlock++, ...rule });
  };

  for (const entry of ordered) {
    if (!entry.hosts) {
      push(entry.rule);
      continue;
    }
    const hosts = pruneSubdomains(entry.hosts);
    const { template } = entry;
    // Обычная блокировка домена целиком → скрипты, картинки, XHR и фреймы получают пустой успешный ответ.
    const neuterable = neuter && template.action.type === 'block' && template.priority === PRIORITY.block
      && !template.condition.resourceTypes && !template.condition.excludedResourceTypes;
    for (let i = 0; i < hosts.length; i += chunkSize) {
      const requestDomains = hosts.slice(i, i + chunkSize);
      push({ ...template, condition: { requestDomains, ...template.condition } });
      if (!neuterable) continue;
      for (const n of NEUTER) {
        push({
          priority: PRIORITY.neuter,
          action: { type: 'redirect', redirect: { extensionPath: resourcesDir + n.file } },
          condition: { requestDomains, ...template.condition, resourceTypes: n.types },
        });
      }
    }
  }

  return { rules, stats: { rules: rules.length, dropped, invalid } };
}

// ─── скриптлеты ──────────────────────────────────────────────────────────────

/**
 * Таблица скриптлетов для lookupScriptlets(): { hosts: {host: [[name, ...args]]}, exceptions: {host: [key]} }.
 * Общие (без домена) скриптлеты пропускаются — как и в uBlock Origin, они слишком опасны.
 */
export function compileScriptlets(filters, { entities = true } = {}) {
  const hosts = new Map();
  const exceptions = new Map();
  const globalExceptions = new Set();
  let skipped = 0;
  const keyOf = (f) => (f.name ? JSON.stringify([f.name, ...f.args]) : '');
  const add = (map, host, key, value) => {
    if (!entities && host.endsWith('.*')) {
      skipped++;
      return;
    }
    let m = map.get(host);
    if (!m) map.set(host, (m = new Map()));
    m.set(key, value);
  };

  for (const f of filters) {
    const key = keyOf(f);
    if (f.exception) {
      if (!f.include.length) {
        if (key) globalExceptions.add(key);
      } else for (const d of f.include) add(exceptions, d, key, key);
      continue;
    }
    if (!f.include.length) {
      skipped++;
      continue;
    }
    for (const d of f.include) add(hosts, d, key, [f.name, ...f.args]);
    for (const d of f.exclude) add(exceptions, d, key, key);
  }

  const table = { hosts: {}, exceptions: {} };
  let count = 0;
  for (const [host, m] of [...hosts].sort((a, b) => a[0].localeCompare(b[0]))) {
    const list = [...m].filter(([k]) => !globalExceptions.has(k)).map(([, v]) => v);
    if (list.length) {
      table.hosts[host] = list;
      count += list.length;
    }
  }
  for (const [host, m] of [...exceptions].sort((a, b) => a[0].localeCompare(b[0]))) table.exceptions[host] = [...m.keys()];
  return { table, stats: { hosts: Object.keys(table.hosts).length, entries: count, skipped } };
}

// ─── косметика ───────────────────────────────────────────────────────────────

/** Делит `a, b:not(c, d)` по запятым верхнего уровня. */
export function splitSelectorList(selector) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '\\') i++;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(selector.slice(start).trim());
  return out.filter(Boolean);
}

const KEY_RE = /^(?:[a-zA-Z][\w-]*)?([.#][a-zA-Z_-][\w-]*)(?=$|[\s.#[:>+~])/;

/**
 * «Ключ» общего селектора: `.ad-banner`, `#ad_box`. Такой селектор может сработать,
 * только если на странице есть элемент с этим классом/id — поэтому его можно
 * внедрять лениво, по мере появления таких элементов.
 */
export function selectorKey(entry) {
  const m = KEY_RE.exec(entry.replace(STYLE_SUFFIX_RE, '$1'));
  return m ? m[1] : null;
}

/** Собирает данные косметической фильтрации из разобранных фильтров. */
export function compileCosmetic(filters, directives = []) {
  const generic = new Set();
  const globalExceptions = new Set();
  const specific = new Map();
  const exceptions = new Map();
  const add = (map, host, body) => {
    let set = map.get(host);
    if (!set) map.set(host, (set = new Set()));
    set.add(body);
  };

  for (const f of filters) {
    const bodies = STYLE_SUFFIX_RE.test(f.body) ? [f.body] : splitSelectorList(f.body);
    for (const body of bodies) {
      if (f.exception) {
        if (!f.include.length) globalExceptions.add(body);
        else for (const d of f.include) add(exceptions, d, body);
        continue;
      }
      if (!f.include.length) generic.add(body);
      else for (const d of f.include) add(specific, d, body);
      for (const d of f.exclude) add(exceptions, d, body);
    }
  }

  for (const body of globalExceptions) {
    generic.delete(body);
    for (const set of specific.values()) set.delete(body);
  }

  const keyed = {};
  const broad = [];
  for (const body of generic) {
    const key = selectorKey(body);
    if (key) (keyed[key] ??= []).push(body);
    else broad.push(body);
  }

  const toObject = (map) => {
    const obj = {};
    for (const [k, set] of [...map].sort((a, b) => a[0].localeCompare(b[0]))) if (set.size) obj[k] = [...set];
    return obj;
  };
  const directiveHosts = (mode) => uniq(directives.filter((d) => d.mode === mode).flatMap((d) => d.hosts)).sort();

  return {
    generic: { keyed, broad },
    specific: toObject(specific),
    exceptions: toObject(exceptions),
    noGeneric: directiveHosts('generic'),
    noSpecific: directiveHosts('specific'),
    noCosmetic: directiveHosts('all'),
  };
}
