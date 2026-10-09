import { SITE_ACCESS, hasSiteAccess, loadState, normalizeHost } from '../lib/state.js';

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('ru-RU');
const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

let state = await loadState();

// ─── переключатели ───────────────────────────────────────────────────────────

function renderToggles() {
  for (const input of document.querySelectorAll('#toggles input[data-key]')) {
    input.checked = Boolean(state.settings[input.dataset.key]);
  }
  $('toggles').classList.toggle('off', !state.settings.enabled);
}

$('toggles').addEventListener('change', async (e) => {
  const key = e.target.dataset?.key;
  if (!key) return;
  state.settings = { ...state.settings, [key]: e.target.checked };
  await chrome.storage.local.set({ settings: state.settings });
  renderToggles();
});

// ─── исключения ──────────────────────────────────────────────────────────────

$('allowlist').value = state.allowlist.join('\n');

$('save-allowlist').addEventListener('click', async () => {
  const hosts = [];
  const bad = [];
  for (const line of $('allowlist').value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const host = normalizeHost(trimmed);
    if (host) {
      if (!hosts.includes(host)) hosts.push(host);
    } else bad.push(trimmed);
  }
  state.allowlist = hosts;
  await chrome.storage.local.set({ allowlist: hosts });
  $('allowlist').value = hosts.join('\n');
  const note = $('allowlist-note');
  if (bad.length) {
    note.className = 'note warn';
    note.textContent = `Сохранено. Не похоже на домен и пропущено: ${bad.join(', ')}`;
  } else {
    note.className = 'note ok';
    note.textContent = `Сохранено: ${hosts.length} ${plural(hosts.length, 'сайт', 'сайта', 'сайтов')}.`;
  }
});

// ─── мои фильтры ─────────────────────────────────────────────────────────────

$('filters').value = state.userFilters;
let awaitingReport = false;

$('save-filters').addEventListener('click', async () => {
  const text = $('filters').value.replace(/\r\n/g, '\n');
  awaitingReport = true;
  $('filters-note').className = 'note';
  $('filters-note').textContent = 'Применяю…';
  await chrome.storage.local.set({ userFilters: text });
  // Если текст не изменился, фон не пересобирает правила — покажем прошлый отчёт.
  if (text === state.userFilters) showReport((await chrome.storage.local.get('userFiltersReport')).userFiltersReport);
  state.userFilters = text;
});

function showReport(report) {
  awaitingReport = false;
  if (!report) return;
  const note = $('filters-note');
  const parts = [];
  if (report.network) parts.push(`${report.network} сетевых`);
  if (report.cosmetic) parts.push(`${report.cosmetic} косметических`);
  if (report.scriptlets) parts.push(`${report.scriptlets} ${plural(report.scriptlets, 'скриптлет', 'скриптлета', 'скриптлетов')}`);
  const problems = (report.unsupported || 0) + (report.ruleErrors?.length || 0);
  note.className = problems ? 'note warn' : 'note ok';
  note.textContent = parts.length ? `Применено: ${parts.join(', ')}.` : 'Фильтров нет.';
  if (problems) note.textContent += ` Не принято: ${problems}.`;

  const list = $('filters-report');
  list.replaceChildren();
  for (const r of report.rejected || []) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = r.line;
    li.append(code, ` — ${describeReason(r.reason)}`);
    list.append(li);
  }
  for (const r of report.ruleErrors || []) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = r.rule;
    li.append(code, ` — Chrome отклонил правило: ${r.error}`);
    list.append(li);
  }
  list.hidden = !list.children.length;
}

function describeReason(reason) {
  if (reason === 'regex') return 'регулярные выражения не поддерживаются';
  if (reason === 'procedural' || reason === 'scriptlet' || reason === 'snippet') return 'процедурные фильтры и скриптлеты не поддерживаются';
  if (reason === 'non-ascii') return 'в адресе есть не-латинские символы';
  if (reason === 'too-broad') return 'слишком общий фильтр — заблокировал бы всё';
  if (reason.startsWith('scriptlet:')) return `скриптлет «${reason.slice(10)}» не поддерживается`;
  if (reason.startsWith('option:')) return `неизвестная опция «${reason.slice(7)}»`;
  return 'не удалось разобрать';
}

// ─── статистика и списки ─────────────────────────────────────────────────────

async function renderStats() {
  const { stats } = await chrome.storage.local.get('stats');
  const n = stats?.blocked || 0;
  $('total').textContent = fmt.format(n);
  $('total-lbl').textContent = `${plural(n, 'запрос', 'запроса', 'запросов')} заблокировано`;
  $('stats-since').textContent = stats?.since
    ? `Считаем с ${new Date(stats.since).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`
    : '';
}

$('reset-stats').addEventListener('click', async () => {
  if (!confirm('Сбросить счётчик заблокированных запросов?')) return;
  await chrome.storage.local.set({ stats: { blocked: 0, since: Date.now() } });
  renderStats();
});

async function renderMeta() {
  let meta;
  try {
    meta = await (await fetch('../data/meta.json')).json();
  } catch {
    return;
  }
  $('meta-built').textContent = `Собрано ${new Date(meta.builtAt).toLocaleString('ru-RU')}.`;
  const tbody = $('lists');
  tbody.replaceChildren();
  for (const list of meta.lists) {
    const tr = document.createElement('tr');
    const cells = [
      list.title,
      list.present ? fmt.format(list.network) : '—',
      list.present ? fmt.format(list.cosmetic) : '—',
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    const status = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${list.present ? 'on' : 'off'}`;
    badge.textContent = list.present ? 'подключён' : 'не скачан';
    status.append(badge);
    tr.append(status);
    tbody.append(tr);
  }
  const r = meta.rules;
  $('meta-rules').textContent = `реклама ${fmt.format(r.ads.rules)}, трекеры ${fmt.format(r.trackers.rules)}, раздражители ${fmt.format(r.annoyances.rules)}; скриптлетов ${fmt.format(meta.scriptlets?.entries || 0)}`;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.stats) renderStats();
  if (changes.userFiltersReport && awaitingReport) showReport(changes.userFiltersReport.newValue);
  if (changes.settings) {
    state.settings = { ...state.settings, ...changes.settings.newValue };
    renderToggles();
  }
});

// ─── доступ к сайтам (Firefox) ───────────────────────────────────────────────

async function renderAccess() {
  $('access').hidden = await hasSiteAccess();
}
$('grant-access').addEventListener('click', async () => {
  try {
    await chrome.permissions.request(SITE_ACCESS);
  } catch {
    // пользователь закрыл окно
  }
  renderAccess();
});
chrome.permissions.onAdded?.addListener(renderAccess);
renderAccess();

$('welcome').hidden = location.hash !== '#welcome';
$('version').textContent = `v${chrome.runtime.getManifest().version}`;
renderToggles();
renderStats();
renderMeta();
