import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALLOW_ID_BASE, PRIORITY, compileCosmetic, compileNetwork, compileScriptlets, parseFilterList, parseLine, selectorKey,
  splitScriptletArgs, splitSelectorList,
} from '../../extension/lib/abp.js';
import { CosmeticEngine, entriesToCSS, hostCandidates } from '../../extension/lib/cosmetic.js';
import { lookupScriptlets, normalizeScriptletName } from '../../extension/lib/scriptlets.js';

const compile = (text, opts) => compileNetwork(parseFilterList(text).network, opts).rules;

test('комментарии и заголовки пропускаются', () => {
  assert.equal(parseLine('! comment'), null);
  assert.equal(parseLine('[Adblock Plus 2.0]'), null);
  assert.equal(parseLine('# hosts comment'), null);
  assert.equal(parseLine('   '), null);
});

test('фильтры доменов сливаются в одно правило requestDomains, поддомены схлопываются', () => {
  const rules = compile('||ads.example.com^\n||example.com^\n||tracker.net^\n0.0.0.0 hosts-style.org');
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0], {
    id: 1,
    priority: PRIORITY.block,
    action: { type: 'block' },
    condition: { requestDomains: ['example.com', 'hosts-style.org', 'tracker.net'] },
  });
});

test('опции: типы, third-party, domain=, match-case', () => {
  const [rule] = compile('/banner/*$script,image,third-party,domain=site.ru|~sub.site.ru,match-case');
  assert.deepEqual(rule.condition, {
    urlFilter: '/banner/',
    isUrlFilterCaseSensitive: true,
    initiatorDomains: ['site.ru'],
    excludedInitiatorDomains: ['sub.site.ru'],
    domainType: 'thirdParty',
    resourceTypes: ['script', 'image'],
  });
});

test('отрицание типов → excludedResourceTypes (без main_frame)', () => {
  const [rule] = compile('||cdn.example.com/ads/$~script');
  assert.deepEqual(rule.condition.excludedResourceTypes, ['main_frame', 'script']);
});

test('исключения и $document → allow / allowAllRequests с высоким приоритетом', () => {
  const rules = compile('@@||good.com/ads.js\n@@||trusted.org^$document');
  const allow = rules.find((r) => r.action.type === 'allow');
  const all = rules.find((r) => r.action.type === 'allowAllRequests');
  assert.ok(allow.id > ALLOW_ID_BASE && all.id > ALLOW_ID_BASE);
  assert.equal(allow.priority, PRIORITY.allow);
  assert.deepEqual(all.condition, { requestDomains: ['trusted.org'], resourceTypes: ['main_frame', 'sub_frame'] });
});

test('$important побеждает исключения, redirect — обычную блокировку', () => {
  const rules = compile('||x.com/a.js$important\n||x.com/gpt.js$script,redirect=googletagservices_gpt.js\n||x.com/y.js$redirect=unknown.js\n||x.com/z.js$redirect-rule=unknown.js');
  assert.equal(rules.length, 3);
  assert.equal(rules[0].priority, PRIORITY.importantBlock);
  assert.ok(PRIORITY.importantBlock > PRIORITY.allow && PRIORITY.allow > PRIORITY.redirect);
  assert.ok(PRIORITY.redirect > PRIORITY.neuter && PRIORITY.neuter > PRIORITY.block, 'явная заглушка важнее «пустого ответа»');
  assert.deepEqual(rules[1].action, { type: 'redirect', redirect: { extensionPath: '/resources/googletagservices_gpt.js' } });
  assert.equal(rules[2].action.type, 'block', 'неизвестный redirect= превращается в блокировку');
});

test('$popup блокирует страницу только для конкретного домена', () => {
  const [targeted] = compile('||popads.net^$popup');
  assert.deepEqual(targeted.condition, { requestDomains: ['popads.net'], resourceTypes: ['main_frame'] });
  const broad = parseFilterList('|http*://$popup,third-party,domain=torrents.example');
  assert.equal(broad.network.length, 0, 'широкий $popup сломал бы переходы по ссылкам');
});

test('badfilter отменяет фильтр', () => {
  const rules = compile('||ads.com^\n||ads.com^$badfilter\n||keep.com^');
  assert.deepEqual(rules[0].condition.requestDomains, ['keep.com']);
});

test('неподдерживаемое отбрасывается, а не расширяется', () => {
  const parsed = parseFilterList([
    '/ads[0-9]+\\.js/',
    '||example.com^$csp=script-src none',
    'example.com##+js(trusted-set-cookie, x, 1)',
    'example.com##div:has-text(Реклама)',
    'example.com#$#abort-on-property-read x',
    '/путь/реклама.js',
    '*$script',
    '||x.com^$domain=google.*',
  ].join('\n'));
  assert.equal(parsed.network.length + parsed.cosmetic.length, 0);
  assert.equal(parsed.unsupported, 8);
});

test('IDN-домены переводятся в punycode', () => {
  const [byOption] = compile('/ad.js$domain=пример.рф');
  assert.deepEqual(byOption.condition.initiatorDomains, ['xn--e1afmkfd.xn--p1ai']);
  const [byPattern] = compile('||пример.рф^');
  assert.deepEqual(byPattern.condition.requestDomains, ['xn--e1afmkfd.xn--p1ai']);
  const [cosmetic] = parseFilterList('пример.рф##.ad').cosmetic;
  assert.deepEqual(cosmetic.include, ['xn--e1afmkfd.xn--p1ai']);
});

test('generichide/elemhide → директивы косметики', () => {
  const parsed = parseFilterList('@@||news.ru^$generichide\n@@||shop.ru^$elemhide');
  const data = compileCosmetic(parsed.cosmetic, parsed.directives);
  assert.deepEqual(data.noGeneric, ['news.ru']);
  assert.deepEqual(data.noCosmetic, ['shop.ru']);
});

test('косметика: ключи, специфичные, исключения, :style, :-abp-has', () => {
  const parsed = parseFilterList([
    '##.ad-banner',
    '##div.sponsor > img',
    '##[id^="div-gpt-ad"]',
    '##.a, .b:not(.c, .d)',
    'site.ru,~m.site.ru##.promo',
    'google.*###tads',
    'site.ru#@#.ad-banner',
    '#@#.b:not(.c, .d)',
    'site.ru##body:style(overflow: auto)',
    'site.ru#?#div:-abp-has(> .ad)',
  ].join('\n'));
  const data = compileCosmetic(parsed.cosmetic, parsed.directives);
  assert.deepEqual(data.generic.keyed, { '.ad-banner': ['.ad-banner'], '.sponsor': ['div.sponsor > img'], '.a': ['.a'] });
  assert.deepEqual(data.generic.broad, ['[id^="div-gpt-ad"]']);
  assert.deepEqual(data.specific['site.ru'], ['.promo', 'body:style(overflow: auto)', 'div:has(> .ad)']);
  assert.deepEqual(data.specific['google.*'], ['#tads']);
  assert.deepEqual(data.exceptions['m.site.ru'], ['.promo']);
  assert.deepEqual(data.exceptions['site.ru'], ['.ad-banner']);
});

test('splitSelectorList и selectorKey', () => {
  assert.deepEqual(splitSelectorList('a, b:not(c, d), [x="1,2"]'), ['a', 'b:not(c, d)', '[x="1,2"]']);
  assert.equal(selectorKey('#ad_box'), '#ad_box');
  assert.equal(selectorKey('ins.adsbygoogle'), '.adsbygoogle');
  assert.equal(selectorKey('.ad-banner:not(.x)'), '.ad-banner');
  assert.equal(selectorKey('[class^="ad"]'), null);
  assert.equal(selectorKey('div > .ad'), null);
});

test('CosmeticEngine: хост, поддомены, сущности, исключения, ленивые ключи', () => {
  const parsed = parseFilterList([
    '##.ad-banner',
    '##[data-ad]',
    'example.com##.promo',
    'google.*###tads',
    'shop.example.com#@#.ad-banner',
    'shop.example.com#@#[data-ad]',
  ].join('\n'));
  const engine = new CosmeticEngine([compileCosmetic(parsed.cosmetic, parsed.directives)]);

  assert.deepEqual(engine.forHost('www.example.com').entries.sort(), ['.promo', '[data-ad]']);
  assert.deepEqual(engine.forTokens('www.example.com', ['.ad-banner', '.other']), ['.ad-banner']);
  assert.deepEqual(engine.forHost('shop.example.com').entries, ['.promo']);
  assert.deepEqual(engine.forTokens('shop.example.com', ['.ad-banner']), []);
  assert.ok(engine.forHost('www.google.co.uk').entries.includes('#tads'));
  assert.ok(hostCandidates('www.google.co.uk').includes('google.*'));
});

test('entriesToCSS: одно правило на селектор, :style получает !important', () => {
  assert.equal(entriesToCSS(['.a', 'body:style(overflow: auto; filter: none !important)']),
    '.a{display:none!important}\nbody{overflow: auto !important;filter: none !important}');
});

test('neuter: домены получают пустые ответы вместо ошибок, кроме $important и явных типов', () => {
  const rules = compileNetwork(parseFilterList('||ads.net^\n||strict.net^$important\n||img.net^$image').network, { neuter: true }).rules;
  const byAction = (host) => rules.filter((r) => r.condition.requestDomains?.includes(host));
  const ads = byAction('ads.net');
  assert.equal(ads.length, 5);
  assert.deepEqual(ads.filter((r) => r.action.type === 'redirect').map((r) => [r.condition.resourceTypes[0], r.action.redirect.extensionPath, r.priority]), [
    ['script', '/resources/noop.js', PRIORITY.neuter],
    ['image', '/resources/1x1.gif', PRIORITY.neuter],
    ['xmlhttprequest', '/resources/noop.txt', PRIORITY.neuter],
    ['sub_frame', '/resources/noop.html', PRIORITY.neuter],
  ]);
  assert.equal(byAction('strict.net').length, 1);
  assert.equal(byAction('img.net').length, 1);
});

test('скриптлеты: синтаксис uBO, AdGuard, псевдонимы, кавычки и экранирование', () => {
  assert.deepEqual(splitScriptletArgs('set, a.b, "x, y", \'q\', c\\,d'), ['set', 'a.b', 'x, y', 'q', 'c,d']);
  assert.equal(normalizeScriptletName('nostif.js'), 'no-setTimeout-if');
  assert.equal(normalizeScriptletName('ubo-aopr'), 'abort-on-property-read');
  assert.equal(normalizeScriptletName('prevent-setTimeout'), 'no-setTimeout-if');
  assert.equal(normalizeScriptletName('trusted-set-cookie'), null);

  const parsed = parseFilterList([
    'site.ru,~m.site.ru##+js(set, canRunAds, true)',
    "other.com#%#//scriptlet('abort-current-inline-script', 'document.write', 'adblock')",
    'site.ru#@#+js(nostif, adb)',
    'free.org#@#+js()',
    '##+js(nobab)',
  ].join('\n'));
  assert.equal(parsed.scriptlets.length, 5);
  assert.deepEqual([parsed.scriptlets[0].name, parsed.scriptlets[0].args], ['set-constant', ['canRunAds', 'true']]);
  assert.deepEqual([parsed.scriptlets[1].name, parsed.scriptlets[1].args], ['abort-current-script', ['document.write', 'adblock']]);

  const { table, stats } = compileScriptlets([
    ...parsed.scriptlets,
    ...parseFilterList('site.ru##+js(nostif, adb)\nfree.org##+js(aopr, x)\ngoogle.*##+js(aopr, y)').scriptlets,
  ]);
  assert.equal(stats.skipped, 1, 'общий скриптлет без домена пропущен');
  assert.deepEqual(lookupScriptlets(table, 'www.site.ru'), [['set-constant', 'canRunAds', 'true']]);
  assert.deepEqual(lookupScriptlets(table, 'm.site.ru'), [], 'исключение ~m.site.ru');
  assert.deepEqual(lookupScriptlets(table, 'free.org'), [], '#@#+js() отключает всё');
  assert.deepEqual(lookupScriptlets(table, 'www.google.com'), [['abort-on-property-read', 'y']]);
  assert.deepEqual(compileScriptlets(parseFilterList('google.*##+js(aopr, y)').scriptlets, { entities: false }).stats.hosts, 0);
});

test('лимит правил соблюдается', () => {
  const text = Array.from({ length: 50 }, (_, i) => `/path${i}/ad.js`).join('\n');
  const { rules, stats } = compileNetwork(parseFilterList(text).network, { maxRules: 10 });
  assert.equal(rules.length, 10);
  assert.equal(stats.dropped, 40);
});
