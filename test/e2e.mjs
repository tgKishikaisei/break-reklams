#!/usr/bin/env node
/**
 * Сквозной тест: настоящий Chrome (headless) + расширение + тестовые страницы.
 * Внешний DNS отключён (--host-resolver-rules), в интернет тест не ходит:
 *   заблокированный запрос → net::ERR_BLOCKED_BY_CLIENT, пропущенный → net::ERR_NAME_NOT_RESOLVED.
 * www.youtube.com направлен на локальный HTTPS-сервер с фальшивой страницей YouTube.
 *
 *   npm run e2e
 * Переменные окружения: CHROME — путь к браузеру, E2E_OUT — папка для скриншотов, OPENSSL — путь к openssl.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScriptlets } from '../extension/lib/scriptlets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const SITE = path.join(ROOT, 'test', 'site');
const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), 'break-reklams-e2e');
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, details = '') {
  results.push({ name, ok: Boolean(ok), details });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && details ? `\n      ${details}` : ''}`);
}

// ─── CDP поверх --remote-debugging-pipe ──────────────────────────────────────

class CDP {
  constructor(proc) {
    this.out = proc.stdio[3];
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    let buffer = Buffer.alloc(0);
    proc.stdio[4].on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let end;
      while ((end = buffer.indexOf(0)) !== -1) {
        const msg = JSON.parse(buffer.subarray(0, end).toString('utf8'));
        buffer = buffer.subarray(end + 1);
        this.dispatch(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.out.write(`${JSON.stringify(msg)}\0`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  dispatch(msg) {
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of this.listeners) fn(msg);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitFor(predicate, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('таймаут ожидания события CDP'));
      }, timeout);
      const off = this.on((msg) => {
        if (!predicate(msg)) return;
        clearTimeout(timer);
        off();
        resolve(msg);
      });
    });
  }
}

async function evaluate(cdp, sessionId, expression, extra = {}) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...extra }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function poll(fn, { timeout = 10000, interval = 150 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

// ─── локальный HTTPS-сервер ──────────────────────────────────────────────────

function makeCert(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const candidates = [process.env.OPENSSL, 'openssl', 'C:/Program Files/Git/mingw64/bin/openssl.exe', 'C:/Program Files/Git/usr/bin/openssl.exe'].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
      return { key: readFileSync(key), cert: readFileSync(cert) };
    } catch {
      // пробуем следующий путь
    }
  }
  throw new Error('Нужен openssl (есть в Git for Windows) — укажите путь в переменной OPENSSL');
}

function startServer(tls) {
  const server = https.createServer(tls, (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const { pathname } = new URL(req.url, 'https://local');
    const send = (type, body) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (host === 'www.youtube.com') {
      if (pathname === '/youtubei/v1/player') {
        return send('application/json', JSON.stringify({ videoDetails: { videoId: 'test' }, adPlacements: [{}], playerAds: [{}] }));
      }
      return send('text/html; charset=utf-8', readFileSync(path.join(SITE, 'youtube.html')));
    }
    if (pathname === '/ads.html') return send('text/html; charset=utf-8', readFileSync(path.join(SITE, 'ads.html')));
    if (pathname === '/vast.xml') {
      return send('text/xml', '<?xml version="1.0" encoding="UTF-8"?>\n<VAST version="3.0"><Ad id="1"><InLine><AdSystem>Test</AdSystem><Creatives><Creative><Linear><Duration>00:00:15</Duration><MediaFiles><MediaFile type="video/mp4">https://ads.example/ad.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>');
    }
    if (pathname === '/data.xml') return send('text/xml', '<?xml version="1.0"?><rss><channel><title>Новости</title></channel></rss>');
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ─── основной сценарий ───────────────────────────────────────────────────────

async function main() {
  if (!CHROME) throw new Error('Chrome не найден — укажите путь в переменной CHROME');
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'br-e2e-'));
  const server = await startServer(makeCert(tmp));
  const port = server.address().port;
  const origin = `https://127.0.0.1:${port}`;

  const proc = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${path.join(tmp, 'profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--ignore-certificate-errors',
    '--host-resolver-rules=EXCLUDE 127.0.0.1,EXCLUDE localhost,MAP www.youtube.com 127.0.0.1,MAP break-reklams.test 127.0.0.1,MAP * ~NOTFOUND',
    '--window-size=1280,900',
    // На CI-машинах Ubuntu 24.04 песочница Chrome недоступна без особых прав.
    ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  proc.stdio[2].on('data', () => {});
  const cdp = new CDP(proc);

  const swErrors = [];
  const pageErrors = [];
  try {
    console.log(`Chrome: ${(await cdp.send('Browser.getVersion')).product}`);
    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    console.log(`Расширение загружено: ${extId}\n`);

    // service worker расширения
    const swTarget = await poll(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
    });
    if (!swTarget) throw new Error('service worker расширения не запустился');
    const { sessionId: sw } = await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    cdp.on((msg) => {
      if (msg.sessionId !== sw) return;
      if (msg.method === 'Runtime.exceptionThrown') swErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') swErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    });
    await cdp.send('Runtime.enable', {}, sw);
    const swEval = (expr) => evaluate(cdp, sw, expr);
    // Сразу после запуска у service worker ещё может не быть API chrome.* — ждём, пока появится.
    const swEvalSoft = (expr) => swEval(expr).catch(() => null);
    const apiReady = await poll(() => swEvalSoft(`typeof chrome === 'object' && Boolean(chrome.scripting && chrome.declarativeNetRequest)`));
    if (!apiReady) throw new Error('у service worker расширения не появился API chrome.*');

    const ALL_SCRIPTS = 'guard-main,scriptlets,vast-main,youtube-main';
    const ready = await poll(() => swEvalSoft(`chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id).sort().join(','))`).then((ids) => ids === ALL_SCRIPTS && ids));
    console.log('Инициализация');
    check(`фон зарегистрировал скрипты MAIN-мира (${ALL_SCRIPTS})`, ready === ALL_SCRIPTS, ready);
    const rulesets = await swEval('chrome.declarativeNetRequest.getEnabledRulesets()');
    check('включены наборы правил ads и trackers', rulesets.includes('ads') && rulesets.includes('trackers') && !rulesets.includes('annoyances'), JSON.stringify(rulesets));

    // ── сетевые правила ──
    console.log('\nСетевые правила (testMatchOutcome)');
    const cases = [
      ['adsbygoogle.js → заглушка adsbygoogle', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script', 'redirect:googlesyndication_adsbygoogle.js'],
      ['gtm.js → заглушка GTM', 'https://www.googletagmanager.com/gtm.js?id=GTM-X', 'script', 'redirect:googletagmanager_gtm.js'],
      ['DoubleClick XHR → пустой ответ', 'https://securepubads.g.doubleclick.net/gampad/ads?x=1', 'xmlhttprequest', 'redirect:noop.txt'],
      ['РСЯ-скрипт → пустой скрипт', 'https://an.yandex.ru/system/context.js', 'script', 'redirect:noop.js'],
      ['рекламный iframe → пустая страница', 'https://tpc.googlesyndication.com/safeframe/1-0-40/html/container.html', 'sub_frame', 'redirect:noop.html'],
      ['Google Analytics beacon', 'https://www.google-analytics.com/g/collect?v=2', 'ping', 'block'],
      ['Яндекс.Метрика', 'https://mc.yandex.ru/metrika/tag.js', 'script', 'block'],
      ['Яндекс ads/system', 'https://yandex.ru/ads/system/context.js', 'script', 'block'],
      ['YouTube stats/ads', 'https://www.youtube.com/api/stats/ads?ver=2', 'xmlhttprequest', 'block', 'https://www.youtube.com'],
      ['VAST-сервер плеера (ufouxbwn.com)', 'https://vast2.ufouxbwn.com/?q=1', 'xmlhttprequest', 'redirect:noop.txt', 'https://ceramet.net'],
      ['VAST по шаблону /ovpaid.php', 'https://code.newadnet.example/ovpaid.php?v=1&position=pre', 'xmlhttprequest', 'block', 'https://ceramet.net'],
      ['поп-андер popads.net (вкладка)', 'https://popads.net/pop.php', 'main_frame', 'block'],
      ['клик пользователя по рекламе не ломается', 'https://ad.doubleclick.net/ddm/clk/1', 'main_frame', 'none'],
      ['обычный скрипт сайта', 'https://cdn.example.com/app.js', 'script', 'none'],
      ['плеер YouTube', 'https://www.youtube.com/s/player/base.js', 'script', 'none', 'https://www.youtube.com'],
    ];
    const outcomes = await swEval(`(async (cases) => {
      const maps = {};
      for (const id of ['ads', 'trackers', 'annoyances']) {
        maps[id] = new Map((await (await fetch('/rules/' + id + '.json')).json()).map((r) => [r.id, r]));
      }
      maps._dynamic = new Map((await chrome.declarativeNetRequest.getDynamicRules()).map((r) => [r.id, r]));
      const out = [];
      for (const [, url, type, , initiator] of cases) {
        const req = { url, type, tabId: -1, initiator: initiator || 'https://news.example.org' };
        const { matchedRules } = await chrome.declarativeNetRequest.testMatchOutcome(req);
        out.push(matchedRules.map((m) => {
          const action = maps[m.rulesetId]?.get(m.ruleId)?.action;
          if (!action) return '?';
          return action.type === 'redirect' ? 'redirect:' + action.redirect.extensionPath.split('/').pop() : action.type;
        }));
      }
      return out;
    })(${JSON.stringify(cases)})`);
    cases.forEach(([name, , , expected], i) => {
      const got = outcomes[i].length ? outcomes[i][0] : 'none';
      check(`${name}: ${expected}`, got === expected, `получено: ${outcomes[i].join(', ') || 'none'}`);
    });

    // ── страница с рекламой ──
    async function openPage(url) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const urls = new Map();
      const failed = new Map();
      const off = cdp.on((msg) => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Network.requestWillBeSent') urls.set(msg.params.requestId, msg.params.request.url);
        if (msg.method === 'Network.loadingFailed') failed.set(urls.get(msg.params.requestId), msg.params.errorText);
        if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(`${url}: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
      });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      const loaded = cdp.waitFor((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired');
      await cdp.send('Page.navigate', { url }, sessionId);
      await loaded;
      const tabId = await poll(() => swEval(`chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${JSON.stringify(url)})?.id)`));
      return {
        targetId, sessionId, failed, tabId,
        eval: (expr, extra) => evaluate(cdp, sessionId, expr, extra),
        close: async () => {
          off();
          await cdp.send('Target.closeTarget', { targetId });
        },
      };
    }

    const probe = `(() => {
      const state = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return 'removed';
        return getComputedStyle(el).display === 'none' ? 'hidden' : 'visible';
      };
      return {
        content: state('#content'), promo: state('#promo'), ins: state('#ins1'), gpt: state('#div-gpt-ad-123'),
        banner: state('#banner1'), yandex: state('#yandex_rtb_R-A-1-2'), late: state('#late-ad'), custom: state('#custom1'),
        wall: state('#wall'), overflow: getComputedStyle(document.body).overflowY,
        adsbygoogle: Boolean(window.adsbygoogle && window.adsbygoogle.loaded === true),
        insStatus: document.getElementById('ins1')?.getAttribute('data-ad-status'),
        gptChain: window.__results.gptChain === true, gtmCallback: window.__results.gtmCallback === true,
      };
    })()`;
    const vastProbe = `(async () => {
      const xhr = (url, type = '') => new Promise((resolve) => {
        const x = new XMLHttpRequest(); x.open('GET', url); x.responseType = type; x.onload = () => resolve(x); x.send();
      });
      const a = await xhr('/vast.xml');
      const b = await xhr('/vast.xml', 'document');
      const c = await (await fetch('/vast.xml')).text();
      const d = await xhr('/data.xml');
      return { xhrText: a.responseText, xhrXmlAds: a.responseXML.getElementsByTagName('Ad').length, docAds: b.response.getElementsByTagName('Ad').length, fetchText: c, other: d.responseText };
    })()`;

    console.log('\nСтраница с рекламой');
    const page = await openPage(`${origin}/ads.html`);
    await sleep(2500);
    const s = await page.eval(probe);
    check('полезный контент виден', s.content === 'visible' && s.promo === 'visible', JSON.stringify(s));
    check('AdSense <ins class="adsbygoogle"> скрыт', s.ins === 'hidden', s.ins);
    check('слот Google Publisher Tag скрыт', s.gpt === 'hidden', s.gpt);
    check('.ad-banner скрыт (ленивый общий селектор)', s.banner === 'hidden', s.banner);
    check('блок Яндекс РСЯ скрыт', s.yandex === 'hidden', s.yandex);
    check('реклама, добавленная позже, тоже скрыта', s.late === 'hidden', s.late);
    check('окно «отключите AdBlock» убрано', s.wall === 'removed', s.wall);
    check('прокрутка страницы возвращена', s.overflow === 'auto', s.overflow);
    check('заглушка adsbygoogle подменила скрипт', s.adsbygoogle && s.insStatus === 'unfilled', JSON.stringify({ a: s.adsbygoogle, st: s.insStatus }));
    check('заглушка GPT: код сайта отработал без ошибок', s.gptChain);
    check('заглушка GTM вызвала eventCallback', s.gtmCallback);
    const adImg = page.failed.get('https://ad.doubleclick.net/ddm/ad.gif');
    const adImgWidth = await page.eval(`document.getElementById('adimg').naturalWidth`);
    check('картинка с ad.doubleclick.net подменена пустой 1×1 (без ошибки загрузки)', !adImg && adImgWidth === 1, `${adImg} / ${adImgWidth}`);
    const okImg = page.failed.get('https://images.example-cdn.test/photo.jpg');
    check('обычная картинка не тронута', okImg === 'net::ERR_NAME_NOT_RESOLVED', okImg);

    const hidden = await swEval(`chrome.tabs.sendMessage(${page.tabId}, { type: 'stats:hidden' }, { frameId: 0 })`);
    check('счётчик скрытых элементов считает', hidden?.hidden >= 6, JSON.stringify(hidden));
    const matched = await swEval(`chrome.declarativeNetRequest.getMatchedRules({ tabId: ${page.tabId} }).then((r) => r.rulesMatchedInfo.length)`);
    check('getMatchedRules видит заблокированные запросы вкладки', matched >= 3, String(matched));

    // ── незаметность для детекторов блокировщиков ──
    console.log('\nНезаметность для детекторов');
    const stealth = await page.eval(`(async () => {
      const r = {};
      try { r.fetchOk = (await fetch('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')).ok; } catch (e) { r.fetchOk = 'error: ' + e.message; }
      try { await fetch('https://googleads.g.doubleclick.net/pagead/id', { mode: 'no-cors' }); r.noCors = true; } catch (e) { r.noCors = 'error: ' + e.message; }
      r.script = await new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = 'https://an.yandex.ru/system/context.js';
        s.onload = () => resolve('load'); s.onerror = () => resolve('error');
        document.head.appendChild(s);
      });
      const bait = document.createElement('div');
      bait.className = 'ad-banner adsbox pub_300x250 textAd';
      bait.innerHTML = '&nbsp;';
      bait.setAttribute('style', 'width: 1px !important; height: 1px !important; position: absolute !important; left: -10000px !important; top: -1000px !important;');
      document.body.appendChild(bait);
      await new Promise((res) => setTimeout(res, 500));
      r.bait = { h: bait.offsetHeight, parent: bait.offsetParent !== null, display: getComputedStyle(bait).display };
      r.markers = Object.getOwnPropertyNames(window).filter((k) => /^__br/i.test(k));
      const nat = (f) => /\\[native code\\]/.test(Function.prototype.toString.call(f));
      r.native = [window.open, JSON.parse, Response.prototype.json, Response.prototype.text, XMLHttpRequest.prototype.open,
        Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText').get].every(nat);
      r.cssVisible = [...document.styleSheets].some((sheet) => {
        try { return [...sheet.cssRules].some((rule) => /adsbygoogle|ad-banner|div-gpt-ad/.test(rule.cssText)); } catch { return false; }
      });
      return r;
    })()`);
    check('fetch к рекламному скрипту получает успешный ответ', stealth.fetchOk === true, String(stealth.fetchOk));
    check('fetch с mode: no-cors к рекламе не падает', stealth.noCors === true, String(stealth.noCors));
    check('рекламный <script> «загружается» (onload, а не onerror)', stealth.script === 'load', stealth.script);
    check('приманка детектора остаётся «видимой» (высота > 0)', stealth.bait.h > 0 && stealth.bait.parent && stealth.bait.display !== 'none', JSON.stringify(stealth.bait));
    check('нет меток расширения в window', stealth.markers.length === 0, stealth.markers.join(', '));
    check('подменённые функции выглядят родными ([native code])', stealth.native);
    check('наш CSS не виден странице в document.styleSheets', !stealth.cssVisible);

    // ── видеореклама ──
    console.log('\nВидеореклама в плеерах (VAST)');
    const vast = await page.eval(vastProbe);
    check('VAST через XHR → пустой ответ «рекламы нет»', !/<Ad[\s>]/.test(vast.xhrText) && vast.xhrText.includes('<VAST') && vast.xhrXmlAds === 0, vast.xhrText.slice(0, 120));
    check('VAST через XHR (responseType=document) → пустой', vast.docAds === 0, String(vast.docAds));
    check('VAST через fetch → пустой', !/<Ad[\s>]/.test(vast.fetchText) && vast.fetchText.includes('<VAST'), vast.fetchText.slice(0, 120));
    check('обычный XML не тронут', vast.other.includes('<rss>'), vast.other.slice(0, 80));

    // ── скриптлеты ──
    console.log('\nСкриптлеты');
    await page.eval(`document.getElementById('content').setAttribute('onclick', 'void 0')`);
    await page.eval(`(${runScriptlets.toString()})(${JSON.stringify([
      ['set-constant', 'adsBlocked', 'false'],
      ['set-constant', 'cfg.ads.enabled', 'false'],
      ['abort-on-property-read', 'detectAdblock'],
      ['abort-current-script', 'checkAds', 'adblockDetector'],
      ['no-setTimeout-if', 'adblockTimer'],
      ['addEventListener-defuser', 'br-test', 'detectHandler'],
      ['json-prune', 'ads.list'],
      ['no-fetch-if', 'ad-check.example'],
      ['no-xhr-if', 'xhr-check.example'],
      ['remove-attr', 'onclick', '#content'],
      ['nano-setTimeout-booster', 'countdownTick', '3000', '0.02'],
      ['no-window-open-if', 'evil.example'],
      ['set-local-storage-item', 'br-consent', 'accepted'],
      ['nobab'],
    ])})`);
    const sr = await page.eval(`(async () => {
      const r = {};
      r.nowoif = window.open('https://evil.example/') === null;
      const w = window.open('about:blank'); r.openOk = Boolean(w); if (w) w.close();
      window.focus();
      window.adsBlocked = true; r.setConstant = window.adsBlocked === false;
      window.cfg = { ads: { enabled: true } }; r.chain = window.cfg.ads.enabled === false;
      try { void window.detectAdblock; r.aopr = false; } catch (e) { r.aopr = e instanceof ReferenceError; }
      window.checkAds = () => 'ok';
      const s1 = document.createElement('script');
      s1.textContent = 'try { window.__acs1 = checkAds(); /* adblockDetector */ } catch (e) { window.__acs1 = "aborted"; }';
      document.head.appendChild(s1);
      const s2 = document.createElement('script');
      s2.textContent = 'window.__acs2 = checkAds();';
      document.head.appendChild(s2);
      r.acs = window.__acs1 === 'aborted' && window.__acs2 === 'ok';
      setTimeout(function adblockTimer() { window.__t1 = true; }, 10);
      setTimeout(() => { window.__t2 = true; }, 10);
      window.addEventListener('br-test', function detectHandler() { window.__e1 = true; });
      window.addEventListener('br-test', () => { window.__e2 = true; });
      window.dispatchEvent(new Event('br-test'));
      r.aeld = !window.__e1 && window.__e2 === true;
      const j = JSON.parse('{"ads":{"list":[1],"keep":1},"x":1}');
      r.jsonPrune = !('list' in j.ads) && j.ads.keep === 1 && j.x === 1;
      try { r.fetch = (await fetch('https://ad-check.example/ads.js')).status; } catch (e) { r.fetch = 'error'; }
      r.xhr = await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', 'https://xhr-check.example/a'); x.onload = () => res(x.status); x.onerror = () => res('error'); x.send(); });
      r.removeAttr = !document.getElementById('content').hasAttribute('onclick');
      const started = performance.now();
      r.boostMs = await new Promise((res) => setTimeout(function countdownTick() { res(Math.round(performance.now() - started)); }, 3000));
      r.storage = localStorage.getItem('br-consent') === 'accepted';
      r.nobab = await new Promise((res) => {
        if (typeof BlockAdBlock !== 'function') return res(false);
        blockAdBlock.onNotDetected(() => res(true));
        setTimeout(() => res(false), 500);
      });
      await new Promise((res) => setTimeout(res, 50));
      r.nostif = !window.__t1 && window.__t2 === true;
      return r;
    })()`, { userGesture: true });
    check('set-constant: значение подменено и не перезаписывается', sr.setConstant && sr.chain, JSON.stringify({ a: sr.setConstant, chain: sr.chain }));
    check('abort-on-property-read: чтение прерывается', sr.aopr);
    check('abort-current-script: прерывает только нужный скрипт', sr.acs);
    check('no-setTimeout-if: таймер детектора обезврежен, остальные работают', sr.nostif);
    check('addEventListener-defuser: обработчик детектора не добавлен', sr.aeld);
    check('json-prune: рекламные поля вырезаны из JSON', sr.jsonPrune);
    check('no-fetch-if / no-xhr-if: проверочные запросы «успешны» без сети', sr.fetch === 200 && sr.xhr === 200, JSON.stringify({ fetch: sr.fetch, xhr: sr.xhr }));
    check('remove-attr: атрибут удалён', sr.removeAttr);
    // Без ускорения было бы ≥ 3000 мс; запас — на случай, если вкладка на миг ушла в фон (там таймеры тормозятся).
    check('nano-setTimeout-booster: 3 с ожидания → меньше 2 с', sr.boostMs < 2000, `${sr.boostMs} мс`);
    check('no-window-open-if: нужное окно заблокировано, остальные открываются', sr.nowoif && sr.openOk, JSON.stringify({ blocked: sr.nowoif, other: sr.openOk }));
    check('set-local-storage-item и nobab', sr.storage && sr.nobab, JSON.stringify({ storage: sr.storage, nobab: sr.nobab }));

    // ── всплывающие окна ──
    console.log('\nВсплывающие окна');
    const popupBlocked = await page.eval(`window.open('https://popads.net/x') === null`, { userGesture: true });
    check('window.open на поп-андер сеть → отказ', popupBlocked);
    const normalPopup = await page.eval(`(() => { const w = window.open('about:blank', '_blank'); const ok = Boolean(w); if (w) w.close(); return ok; })()`, { userGesture: true });
    check('обычный window.open работает', normalPopup);
    const overlay = await page.eval(`(() => {
      const o = document.createElement('div');
      o.id = 'clickjack';
      o.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:transparent';
      o.addEventListener('click', () => { window.__results.clickjackOpen = window.open('https://some-adnet.example/landing'); });
      document.body.appendChild(o);
      return true;
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 300, button: 'left', clickCount: 1 }, page.sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 300, button: 'left', clickCount: 1 }, page.sessionId);
    await sleep(300);
    const clickjack = await page.eval(`({ opened: window.__results.clickjackOpen !== null && window.__results.clickjackOpen !== undefined, overlay: Boolean(document.getElementById('clickjack')) })`);
    check('клик по невидимому слою: окно не открыто, слой удалён', overlay && !clickjack.opened && !clickjack.overlay, JSON.stringify(clickjack));

    const tabsBefore = await swEval(`chrome.tabs.query({}).then((t) => t.length)`);
    await page.eval(`(() => { const a = document.createElement('a'); a.href = 'https://popads.net/landing'; a.target = '_blank'; document.body.appendChild(a); a.click(); a.remove(); })()`, { userGesture: true });
    const popupClosed = await poll(async () => {
      const tabs = await swEval(`chrome.tabs.query({}).then((t) => t.map((x) => x.url || x.pendingUrl || ''))`);
      return tabs.length <= tabsBefore && !tabs.some((u) => u.includes('popads.net'));
    }, { timeout: 5000 });
    check('рекламная вкладка закрыта автоматически', popupClosed);

    // ── пипетка ──
    console.log('\nПипетка');
    await swEval(`chrome.scripting.executeScript({ target: { tabId: ${page.tabId} }, files: ['content/picker.js'] }).then(() => true)`);
    const rect = await page.eval(`(() => { const r = document.getElementById('promo').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, page.sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, page.sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, page.sessionId);
    await sleep(200);
    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
    writeFileSync(path.join(OUT, 'picker.png'), Buffer.from(shot1.data, 'base64'));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, page.sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, page.sessionId);
    const saved = await poll(() => swEval(`chrome.storage.local.get('userFilters').then((s) => s.userFilters || '')`).then((t) => t.includes('##') && t));
    check('пипетка сохранила правило 127.0.0.1###promo', saved?.trim() === '127.0.0.1###promo', JSON.stringify(saved));
    check('выбранный элемент сразу скрыт', (await page.eval(`getComputedStyle(document.getElementById('promo')).display`)) === 'none');

    // скриншот popup для этой вкладки
    for (const scheme of ['light', 'dark']) {
      const { targetId: popupTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId: ps } = await cdp.send('Target.attachToTarget', { targetId: popupTarget, flatten: true });
      await cdp.send('Page.enable', {}, ps);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 340, height: 360, deviceScaleFactor: 2, mobile: false }, ps);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, ps);
      const loaded = cdp.waitFor((m) => m.sessionId === ps && m.method === 'Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `chrome-extension://${extId}/popup/popup.html?tab=${page.tabId}` }, ps);
      await loaded;
      await sleep(700);
      const info = await evaluate(cdp, ps, `({ blocked: document.getElementById('page-blocked').textContent, hidden: document.getElementById('page-hidden').textContent, host: document.getElementById('host').textContent, h: document.body.scrollHeight })`);
      if (scheme === 'light') check('popup показывает сайт и счётчики', info.host === '127.0.0.1' && info.blocked !== '—' && info.hidden !== '—', JSON.stringify(info));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 340, height: info.h, scale: 1 }, captureBeyondViewport: true }, ps);
      writeFileSync(path.join(OUT, `popup-${scheme}.png`), Buffer.from(shot.data, 'base64'));
      await cdp.send('Target.closeTarget', { targetId: popupTarget });
    }
    await page.close();

    // ── исключения ──
    console.log('\nСайт-исключение');
    await swEval(`chrome.storage.local.set({ allowlist: ['127.0.0.1'] }).then(() => true)`);
    const allowReady = await poll(() => swEval(`Promise.all([chrome.declarativeNetRequest.getDynamicRules(), chrome.scripting.getRegisteredContentScripts()]).then(([r, s]) => r.some((x) => x.action.type === 'allowAllRequests') && s.find((x) => x.id === 'guard-main')?.excludeMatches?.length > 0)`));
    check('правило-исключение добавлено', allowReady);
    const allowed = await openPage(`${origin}/ads.html`);
    await sleep(1500);
    const sa = await allowed.eval(probe);
    check('на сайте-исключении реклама не скрывается', sa.ins === 'visible' && sa.banner === 'visible' && sa.wall === 'visible', JSON.stringify(sa));
    const allowedVast = await allowed.eval(vastProbe);
    check('на сайте-исключении плееры не трогаем', /<Ad[\s>]/.test(allowedVast.xhrText), allowedVast.xhrText.slice(0, 80));
    const allowedImg = allowed.failed.get('https://ad.doubleclick.net/ddm/ad.gif');
    check('на сайте-исключении запросы не блокируются', allowedImg === 'net::ERR_NAME_NOT_RESOLVED', allowedImg);
    await allowed.close();
    await swEval(`chrome.storage.local.set({ allowlist: [] }).then(() => true)`);
    await poll(() => swEval(`chrome.declarativeNetRequest.getDynamicRules().then((r) => !r.some((x) => x.action.type === 'allowAllRequests'))`));

    // ── мои фильтры ──
    console.log('\nМои фильтры');
    await swEval(`chrome.storage.local.set({ userFilters: '127.0.0.1##.custom-ad\\n||custom-tracker.test^\\n/broken[regex/\\n127.0.0.1##+js(set-constant, __brUserProbe, true)\\n' }).then(() => true)`);
    const report = await poll(() => swEval(`chrome.storage.local.get('userFiltersReport').then((s) => s.userFiltersReport?.network === 1 && s.userFiltersReport)`));
    check('отчёт о фильтрах: 1 сетевой, 1 косметический, 1 скриптлет, 1 отклонён', report?.network === 1 && report?.cosmetic === 1 && report?.scriptlets === 1 && report?.unsupported === 1, JSON.stringify(report));
    const userBlock = await swEval(`chrome.declarativeNetRequest.testMatchOutcome({ url: 'https://custom-tracker.test/p.gif', type: 'image', tabId: -1, initiator: 'https://a.example' }).then((r) => r.matchedRules.length)`);
    check('пользовательский сетевой фильтр блокирует', userBlock === 1);
    const custom = await openPage(`${origin}/ads.html`);
    await sleep(1200);
    const sc = await custom.eval(probe);
    check('пользовательский косметический фильтр скрывает', sc.custom === 'hidden' && sc.content === 'visible', JSON.stringify({ custom: sc.custom, content: sc.content }));
    check('пользовательский скриптлет выполнен', (await custom.eval('window.__brUserProbe')) === true);
    await custom.close();

    console.log('\nСкриптлеты из встроенных списков');
    const selftest = await openPage(`https://break-reklams.test:${port}/ads.html`);
    await sleep(500);
    check('скриптлет из списка сработал раньше скриптов страницы', (await selftest.eval('window.__brScriptletProbe')) === true);
    await selftest.close();

    // ── выключатель ──
    console.log('\nГлавный выключатель');
    await swEval(`chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, enabled: false } })).then(() => true)`);
    const off = await poll(() => swEval(`Promise.all([chrome.declarativeNetRequest.getEnabledRulesets(), chrome.scripting.getRegisteredContentScripts()]).then(([r, s]) => r.length === 0 && s.length === 0)`));
    check('при выключении все правила и скрипты сняты', off);
    await swEval(`chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, enabled: true } })).then(() => true)`);
    const on = await poll(() => swEval(`chrome.declarativeNetRequest.getEnabledRulesets().then((r) => r.includes('ads'))`));
    check('при включении правила вернулись', on);
    await poll(() => swEval(`chrome.scripting.getRegisteredContentScripts().then((s) => s.length === 4)`));

    // ── YouTube ──
    console.log('\nYouTube (локальная подделка www.youtube.com)');
    const yt = await openPage(`https://www.youtube.com:${port}/watch?v=test`);
    await sleep(1500);
    const y = await yt.eval(`({ ...window.__yt, feedAd: getComputedStyle(document.getElementById('feed-ad')).display, muted: document.querySelector('video').muted })`);
    check('реклама вырезана из ytInitialPlayerResponse', y.initialHasAds === false && y.initialKeepsData === true, JSON.stringify(y));
    check('реклама вырезана из JSON.parse', y.parseHasAds === false && y.parseKeepsData === true);
    check('реклама вырезана из ответа /youtubei/v1/player', y.fetchHasAds === false && y.fetchKeepsData === true);
    check('кнопка «Пропустить» нажата автоматически', y.skipped === true);
    check('рекламный блок в ленте скрыт', y.feedAd === 'none', y.feedAd);
    await yt.close();

    // ── страница настроек ──
    console.log('\nСтраница настроек');
    for (const scheme of ['light', 'dark']) {
      const { targetId: optTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId: os_ } = await cdp.send('Target.attachToTarget', { targetId: optTarget, flatten: true });
      await cdp.send('Page.enable', {}, os_);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false }, os_);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, os_);
      const loaded = cdp.waitFor((m) => m.sessionId === os_ && m.method === 'Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `chrome-extension://${extId}/options/options.html#welcome` }, os_);
      await loaded;
      await sleep(700);
      const opt = await evaluate(cdp, os_, `({ lists: document.querySelectorAll('#lists tr').length, filters: document.getElementById('filters').value, h: document.documentElement.scrollHeight })`);
      if (scheme === 'light') check('настройки показывают списки и мои фильтры', opt.lists >= 3 && opt.filters.includes('custom-ad'), JSON.stringify(opt));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1000, height: opt.h, scale: 1 }, captureBeyondViewport: true }, os_);
      writeFileSync(path.join(OUT, `options-${scheme}.png`), Buffer.from(shot.data, 'base64'));
      await cdp.send('Target.closeTarget', { targetId: optTarget });
    }

    await sleep(2500);
    const total = await swEval(`chrome.storage.local.get('stats').then((s) => s.stats?.blocked || 0)`);
    check('общий счётчик заблокированного растёт', total > 0, String(total));
  } finally {
    const unexpected = [...swErrors, ...pageErrors];
    if (unexpected.length) {
      console.log('\nОшибки в консоли:');
      for (const e of unexpected) console.log(`  ! ${e}`);
    }
    check('нет ошибок в консоли расширения и страниц', unexpected.length === 0, `${unexpected.length} шт.`);
    try {
      await Promise.race([cdp.send('Browser.close'), sleep(3000)]);
    } catch {
      // браузер уже закрыт
    }
    proc.kill();
    server.close();
    await sleep(500);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // профиль ещё занят Chrome — удалится позже системой
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтого: ${results.length - failed.length} из ${results.length} проверок пройдено. Скриншоты: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
