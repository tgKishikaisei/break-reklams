/**
 * Break Reklams — фоновый скрипт (service worker в Chrome, event page в Firefox).
 *  • включает/выключает наборы сетевых правил (реклама, трекеры, cookie-баннеры);
 *  • собирает динамические правила: сайты-исключения + «Мои фильтры»;
 *  • регистрирует скрипты MAIN-мира (защита от всплывающих окон, YouTube);
 *  • внедряет CSS для скрытия рекламы (origin: USER — страница не может его перебить);
 *  • закрывает рекламные вкладки, считает статистику, запускает «пипетку».
 */

import { ALLOW_ID_BASE, PRIORITY, compileCosmetic, compileNetwork, compileScriptlets, parseFilterList } from './lib/abp.js';
import { CosmeticEngine, entriesToCSS, isHidingEntry } from './lib/cosmetic.js';
import { lookupScriptlets, runScriptlets } from './lib/scriptlets.js';
import { DEFAULT_SETTINGS, hostFromUrl, isAllowlisted, isIPv4, loadState } from './lib/state.js';

const ALLOWLIST_ID_BASE = 20_000_000;
const RULESETS = ['ads', 'trackers', 'annoyances'];
const ICONS_ON = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' };
const ICONS_OFF = { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png', 48: 'icons/icon-off-48.png' };
const WATCHED_KEYS = ['settings', 'allowlist', 'userFilters'];
const IS_FIREFOX = chrome.runtime.getURL('').startsWith('moz-extension:');

// ─── состояние ───────────────────────────────────────────────────────────────

const jsonCache = new Map();
function loadJSON(path) {
  if (!jsonCache.has(path)) {
    jsonCache.set(
      path,
      fetch(chrome.runtime.getURL(path))
        .then((r) => r.json())
        .catch((err) => {
          console.warn('Break Reklams: не удалось загрузить', path, err);
          jsonCache.delete(path);
          return null;
        }),
    );
  }
  return jsonCache.get(path);
}

function compileUserFilters(text) {
  const parsed = parseFilterList(text, { keepRejected: 20 });
  const network = compileNetwork(parsed.network, { maxRules: 5000 });
  return {
    network: network.rules,
    cosmetic: compileCosmetic(parsed.cosmetic, parsed.directives),
    scriptlets: compileScriptlets(parsed.scriptlets).table,
    report: {
      total: parsed.total,
      network: parsed.network.length,
      cosmetic: parsed.cosmetic.length + parsed.directives.length,
      scriptlets: parsed.scriptlets.length,
      unsupported: parsed.unsupported,
      rejected: parsed.rejected,
      ruleErrors: [],
    },
  };
}

let runtime = null;
let runtimePromise = null;

/** Настройки + скомпилированные фильтры. Кешируется до следующего изменения настроек. */
function getRuntime() {
  if (runtime) return Promise.resolve(runtime);
  runtimePromise ??= (async () => {
    const state = await loadState();
    const [ads, annoyances, scriptlets] = await Promise.all([
      loadJSON('data/cosmetic-ads.json'),
      state.settings.annoyances ? loadJSON('data/cosmetic-annoyances.json') : null,
      loadJSON('data/scriptlets.json'),
    ]);
    const user = compileUserFilters(state.userFilters);
    runtime = {
      ...state,
      engine: new CosmeticEngine([ads, annoyances, user.cosmetic]),
      scriptletMatches: scriptlets?.matches || [],
      userScriptlets: user.scriptlets,
      userNetwork: user.network,
      userReport: user.report,
    };
    return runtime;
  })().finally(() => {
    runtimePromise = null;
  });
  return runtimePromise;
}

// ─── применение настроек ─────────────────────────────────────────────────────

let applyChain = Promise.resolve();
function scheduleApply() {
  runtime = null;
  applyChain = applyChain.then(applyNow).catch((err) => console.error('Break Reklams: apply failed', err));
  return applyChain;
}

async function applyNow() {
  runtime = null;
  const rt = await getRuntime();
  const { settings } = rt;
  const on = settings.enabled;

  const want = { ads: on, trackers: on && settings.trackers, annoyances: on && settings.annoyances };
  const current = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
  const enableRulesetIds = RULESETS.filter((id) => want[id] && !current.has(id));
  const disableRulesetIds = RULESETS.filter((id) => !want[id] && current.has(id));
  if (enableRulesetIds.length || disableRulesetIds.length) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
  }

  await syncDynamicRules(rt);
  await syncContentScripts(rt);
  await syncAction(on);
  await chrome.storage.local.set({ userFiltersReport: { ...rt.userReport, updatedAt: Date.now() } });
}

function allowlistRules(allowlist) {
  return allowlist.map((host, i) => ({
    id: ALLOWLIST_ID_BASE + i + 1,
    priority: PRIORITY.allowlist,
    action: { type: 'allowAllRequests' },
    condition: { requestDomains: [host], resourceTypes: ['main_frame'] },
  }));
}

async function syncDynamicRules(rt) {
  const on = rt.settings.enabled;
  const base = on ? allowlistRules(rt.allowlist) : [];
  const user = on ? rt.userNetwork : [];
  const removeRuleIds = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [...base, ...user] });
  } catch (err) {
    // Какое-то пользовательское правило Chrome не принял — добавляем по одному, пропуская плохие.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: base });
    for (const rule of user) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
      } catch (e) {
        if (rt.userReport.ruleErrors.length < 20) {
          rt.userReport.ruleErrors.push({ rule: rule.condition.urlFilter || rule.condition.requestDomains?.join(', ') || `#${rule.id}`, error: String(e.message || e) });
        }
      }
    }
    console.warn('Break Reklams: часть пользовательских правил отклонена', err);
  }
}

function excludeMatchesFor(allowlist) {
  return allowlist.flatMap((h) => (isIPv4(h) ? [`*://${h}/*`] : [`*://${h}/*`, `*://*.${h}/*`]));
}

async function syncContentScripts(rt) {
  const { settings, allowlist } = rt;
  const excludeMatches = excludeMatchesFor(allowlist);
  const scripts = [];
  if (settings.enabled && rt.scriptletMatches.length) {
    scripts.push({
      id: 'scriptlets',
      js: ['generated/scriptlets.js'],
      matches: rt.scriptletMatches,
      excludeMatches,
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
    });
  }
  if (settings.enabled && settings.videoAds) {
    scripts.push({
      id: 'vast-main',
      js: ['content/vast-main.js'],
      matches: ['<all_urls>'],
      excludeMatches,
      runAt: 'document_start',
      allFrames: true,
      ...(IS_FIREFOX ? {} : { matchOriginAsFallback: true }),
      world: 'MAIN',
    });
  }
  if (settings.enabled && settings.popups) {
    scripts.push({
      id: 'guard-main',
      js: ['content/guard-main.js'],
      matches: ['<all_urls>'],
      excludeMatches,
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
    });
  }
  if (settings.enabled && settings.youtube && !isAllowlisted('youtube.com', allowlist)) {
    scripts.push({
      id: 'youtube-main',
      js: ['content/youtube-main.js'],
      matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
    });
  }
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

async function syncAction(on) {
  try {
    await chrome.declarativeNetRequest.setExtensionActionOptions?.({ displayActionCountAsBadgeText: on });
  } catch {
    // в Firefox счётчика на значке может не быть — не страшно
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#E53935' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  await chrome.action.setIcon({ path: on ? ICONS_ON : ICONS_OFF });
  if (!on) await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: on ? 'Break Reklams — защита включена' : 'Break Reklams — защита выключена' });
}

// ─── сообщения от страниц ────────────────────────────────────────────────────

function frameHost(sender) {
  return hostFromUrl(sender.url) || hostFromUrl(sender.origin || '') || hostFromUrl(sender.tab?.url || '');
}

function topHost(sender) {
  return hostFromUrl(sender.tab?.url || '') || frameHost(sender);
}

/** Цель внедрения: конкретный документ (Chrome) или фрейм (Firefox не знает documentIds). */
function targetFor(sender) {
  return sender.documentId && !IS_FIREFOX
    ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
    : { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
}

async function injectCSS(sender, css) {
  if (!css || !sender.tab || sender.tab.id < 0) return;
  try {
    await chrome.scripting.insertCSS({ target: targetFor(sender), css, origin: 'USER' });
  } catch {
    // документ уже закрыт или страница защищена — не страшно
  }
}

/**
 * Скриптлеты из «Моих фильтров». Встроенные списки работают через заранее собранный
 * generated/scriptlets.js (строго раньше скриптов страницы); пользовательские внедряются
 * по сообщению от content-скрипта — очень рано, но без гарантии опередить все скрипты сайта.
 */
async function injectUserScriptlets(sender, entries) {
  if (!entries.length || !sender.tab || sender.tab.id < 0) return;
  try {
    await chrome.scripting.executeScript({ target: targetFor(sender), world: 'MAIN', injectImmediately: true, func: runScriptlets, args: [entries] });
  } catch {
    // документ уже закрыт
  }
}

async function isActiveFor(sender) {
  const rt = await getRuntime();
  if (!rt.settings.enabled || isAllowlisted(topHost(sender), rt.allowlist)) return null;
  return rt;
}

const handlers = {
  async 'cosmetic:init'(_msg, sender) {
    const rt = await isActiveFor(sender);
    if (!rt) return { active: false };
    const host = frameHost(sender);
    if (!host) return { active: true, generic: false, antiAdblock: rt.settings.antiAdblock };
    const scriptlets = lookupScriptlets(rt.userScriptlets, host);
    const { entries, generic } = rt.engine.forHost(host);
    await Promise.all([injectCSS(sender, entriesToCSS(entries)), injectUserScriptlets(sender, scriptlets)]);
    return { active: true, generic, antiAdblock: rt.settings.antiAdblock };
  },

  async 'cosmetic:tokens'(msg, sender) {
    const rt = await isActiveFor(sender);
    const host = frameHost(sender);
    if (!rt || !host || !Array.isArray(msg.tokens)) return { injected: 0 };
    const entries = rt.engine.forTokens(host, msg.tokens.slice(0, 5000));
    await injectCSS(sender, entriesToCSS(entries));
    return { injected: entries.length };
  },

  /** Селекторы, применённые к странице, — для подсчёта скрытых элементов в popup. */
  async 'cosmetic:selectors'(msg, sender) {
    const rt = await isActiveFor(sender);
    const host = frameHost(sender);
    if (!rt || !host) return { selectors: [] };
    const tokens = Array.isArray(msg.tokens) ? msg.tokens : [];
    const selectors = [...rt.engine.forHost(host).entries, ...rt.engine.forTokens(host, tokens)].filter(isHidingEntry);
    return { selectors };
  },

  async 'youtube:check'(_msg, sender) {
    const rt = await isActiveFor(sender);
    return { active: Boolean(rt && rt.settings.youtube) };
  },

  async 'picker:save'(msg) {
    const selector = String(msg.selector || '').trim();
    const host = String(msg.host || '').trim().toLowerCase();
    if (!selector || /[\n{}]/.test(selector) || !/^[a-z0-9.-]+$/.test(host)) return { ok: false };
    const line = `${host}##${selector}`;
    const { userFilters = '' } = await chrome.storage.local.get('userFilters');
    const lines = userFilters.split(/\r?\n/);
    if (!lines.includes(line)) {
      await chrome.storage.local.set({ userFilters: `${userFilters.trimEnd()}\n${line}\n`.replace(/^\n+/, '') });
    }
    return { ok: true, line };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  handler(msg, sender).then(sendResponse, (err) => {
    console.warn('Break Reklams:', msg.type, err);
    sendResponse(null);
  });
  return true;
});

// ─── пипетка («Убрать элемент») ──────────────────────────────────────────────

async function startPicker(tabId, frameId = 0, preselect = false) {
  const target = { tabId, frameIds: [frameId] };
  try {
    if (preselect) await chrome.scripting.executeScript({ target, func: () => { window.__brPickerPreselect = true; } });
    await chrome.scripting.executeScript({ target, files: ['content/picker.js'] });
  } catch (err) {
    console.warn('Break Reklams: пипетку нельзя запустить на этой странице', err);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'br-pick' && tab?.id >= 0) startPicker(tab.id, info.frameId ?? 0, true);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'start-picker' && tab?.id >= 0) startPicker(tab.id);
});

// ─── закрытие рекламных вкладок ──────────────────────────────────────────────
// Вкладка, открытая со страницы, первая навигация которой заблокирована, — это поп-андер.

const freshTabs = new Map();

/** Домены, чьи страницы блокируются целиком ($popup), — из набора правил «реклама». */
let popupHostsPromise = null;
function popupHosts() {
  popupHostsPromise ??= loadJSON('rules/ads.json').then((rules) => new Set((rules || [])
    .filter((r) => r.action.type === 'block' && r.condition.resourceTypes?.length === 1 && r.condition.resourceTypes[0] === 'main_frame')
    .flatMap((r) => r.condition.requestDomains || [])));
  return popupHostsPromise;
}

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  freshTabs.set(d.tabId, Date.now());
  setTimeout(() => freshTabs.delete(d.tabId), 20_000);
});

chrome.webNavigation.onErrorOccurred.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const created = freshTabs.get(d.tabId);
  if (!created || Date.now() - created > 20_000) return;
  // Chrome сообщает net::ERR_BLOCKED_BY_CLIENT; у Firefox свои коды ошибок — сверяем домен со списком.
  if (d.error !== 'net::ERR_BLOCKED_BY_CLIENT') {
    const host = hostFromUrl(d.url);
    const hosts = await popupHosts();
    if (!host || ![...hosts].some((h) => host === h || host.endsWith(`.${h}`))) return;
  }
  const rt = await getRuntime();
  if (!rt.settings.enabled || !rt.settings.popups) return;
  freshTabs.delete(d.tabId);
  chrome.tabs.remove(d.tabId).catch(() => {});
});

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  if (!/^(?:about|chrome|edge)/.test(d.url)) freshTabs.delete(d.tabId);
  // Серая иконка на сайтах-исключениях
  const rt = await getRuntime();
  if (!rt.settings.enabled) return;
  const excluded = isAllowlisted(hostFromUrl(d.url), rt.allowlist);
  chrome.action.setIcon({ tabId: d.tabId, path: excluded ? ICONS_OFF : ICONS_ON }).catch(() => {});
});

// ─── статистика ──────────────────────────────────────────────────────────────
// onRuleMatchedDebug доступен для распакованных расширений — как раз наш случай.

let pendingBlocked = 0;
let statsTimer = 0;

async function flushStats() {
  statsTimer = 0;
  const add = pendingBlocked;
  pendingBlocked = 0;
  if (!add) return;
  const { stats = {} } = await chrome.storage.local.get('stats');
  await chrome.storage.local.set({ stats: { since: stats.since || Date.now(), blocked: (stats.blocked || 0) + add } });
}

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    if (info.rule.ruleId >= ALLOW_ID_BASE) return;
    pendingBlocked++;
    statsTimer ||= setTimeout(flushStats, 2000);
  });
} else {
  // Запасной путь (Firefox): перед уходом со страницы считаем, сколько на ней было заблокировано.
  chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
    if (d.frameId !== 0) return;
    try {
      const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: d.tabId });
      pendingBlocked += rulesMatchedInfo.filter((m) => m.rule.ruleId < ALLOW_ID_BASE).length;
      statsTimer ||= setTimeout(flushStats, 2000);
    } catch {
      // нет доступа к статистике — просто не считаем
    }
  });
}

// ─── жизненный цикл ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS }, stats: { blocked: 0, since: Date.now() } });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'br-pick', title: 'Break Reklams: убрать этот элемент', contexts: ['all'] });
  });

  await scheduleApply();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#welcome') });
});

chrome.runtime.onStartup.addListener(() => scheduleApply());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && WATCHED_KEYS.some((k) => k in changes)) scheduleApply();
});
