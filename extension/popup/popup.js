import { ALLOW_ID_BASE } from '../lib/abp.js';
import { SITE_ACCESS, hasSiteAccess, hostFromUrl, isAllowlisted, loadState, normalizeHost } from '../lib/state.js';

const $ = (id) => document.getElementById(id);
const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('ru-RU');
const fmt = (n) => (n >= 10_000 ? compact.format(n) : full.format(n));

function setCount(id, n, [one, few, many], [verbOne, verbMany]) {
  $(id).textContent = fmt(n);
  const single = plural(n, true, false, false);
  $(`${id}-lbl`).replaceChildren(plural(n, one, few, many), document.createElement('br'), single ? verbOne : verbMany);
}

// ?tab=<id> — открыть popup для конкретной вкладки (используется сквозным тестом)
const forcedTabId = Number(new URLSearchParams(location.search).get('tab'));
const [tab] = forcedTabId ? [await chrome.tabs.get(forcedTabId)] : await chrome.tabs.query({ active: true, currentWindow: true });
const pageHost = tab?.url ? hostFromUrl(tab.url) : '';
const siteKey = pageHost ? normalizeHost(pageHost) : null;
let state = await loadState();

function render() {
  const { enabled } = state.settings;
  const excluded = Boolean(pageHost) && isAllowlisted(pageHost, state.allowlist);
  document.body.classList.toggle('off', !enabled);
  document.body.classList.toggle('excluded', enabled && excluded);

  $('power').setAttribute('aria-checked', String(enabled));
  $('status').textContent = !enabled ? 'Защита выключена' : excluded ? 'Этот сайт в исключениях' : 'Защита включена';

  $('host').textContent = siteKey || 'Служебная страница';
  $('site-toggle').checked = Boolean(siteKey) && !excluded;
  $('site-toggle').disabled = !siteKey || !enabled;
  $('pick').disabled = !siteKey || !enabled || excluded;
}

async function loadCounts() {
  const { stats } = await chrome.storage.local.get('stats');
  const total = stats?.blocked || 0;
  $('total-blocked').textContent = fmt(total);

  if (!siteKey || tab.id < 0) return;
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
    const blocked = rulesMatchedInfo.filter((m) => m.rule.ruleId < ALLOW_ID_BASE).length;
    setCount('page-blocked', blocked, ['запрос', 'запроса', 'запросов'], ['заблокирован', 'заблокировано']);
  } catch {
    $('page-blocked').textContent = '—';
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'stats:hidden' }, { frameId: 0 });
    setCount('page-hidden', res?.hidden ?? 0, ['элемент', 'элемента', 'элементов'], ['скрыт', 'скрыто']);
  } catch {
    $('page-hidden').textContent = '—';
  }
}

async function reloadTab() {
  if (siteKey && tab?.id >= 0) await chrome.tabs.reload(tab.id);
}

$('power').addEventListener('click', async () => {
  state.settings = { ...state.settings, enabled: !state.settings.enabled };
  await chrome.storage.local.set({ settings: state.settings });
  render();
  await reloadTab();
});

$('site-toggle').addEventListener('change', async (e) => {
  if (!siteKey) return;
  const block = e.target.checked;
  const allowlist = state.allowlist.filter((d) => !(pageHost === d || pageHost.endsWith(`.${d}`)));
  if (!block) allowlist.push(siteKey);
  state.allowlist = allowlist;
  await chrome.storage.local.set({ allowlist });
  render();
  // Даём фону время пересобрать правила, затем перезагружаем вкладку.
  setTimeout(reloadTab, 250);
});

$('pick').addEventListener('click', async () => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/picker.js'] });
    window.close();
  } catch {
    $('hint').textContent = 'На этой странице браузер не разрешает запускать пипетку.';
  }
});

$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.stats) $('total-blocked').textContent = fmt(changes.stats.newValue?.blocked || 0);
});

$('grant').addEventListener('click', async () => {
  try {
    await chrome.permissions.request(SITE_ACCESS);
  } catch {
    // окно разрешения закрыто
  }
  $('access').hidden = await hasSiteAccess();
});

render();
loadCounts();
hasSiteAccess().then((ok) => { $('access').hidden = ok; });
