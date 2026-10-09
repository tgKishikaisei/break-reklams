#!/usr/bin/env node
/**
 * Сборка фильтров: filters/*.txt (+ filters/external/*.txt, если скачаны) →
 *   extension/rules/{ads,trackers,annoyances}.json    — правила declarativeNetRequest
 *   extension/data/cosmetic-{ads,annoyances}.json     — косметика
 *   extension/data/meta.json                          — сводка для страницы настроек
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCosmetic, compileNetwork, compileScriptlets, parseFilterList, REDIRECT_RESOURCES } from '../extension/lib/abp.js';
import { lookupScriptlets, runScriptlets } from '../extension/lib/scriptlets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILTERS = path.join(ROOT, 'filters');
const EXT = path.join(ROOT, 'extension');
const CATEGORIES = ['ads', 'trackers', 'annoyances'];

const fmt = (n) => n.toLocaleString('ru-RU');

async function main() {
  const config = JSON.parse(await readFile(path.join(FILTERS, 'lists.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(EXT, 'manifest.json'), 'utf8'));
  const acc = Object.fromEntries(CATEGORIES.map((c) => [c, { network: [], cosmetic: [], directives: [] }]));
  const scriptlets = [];
  const listsMeta = [];

  for (const list of config.lists) {
    const file = path.join(FILTERS, list.file);
    if (!existsSync(file)) {
      listsMeta.push({ id: list.id, title: list.title, category: list.category, present: false, external: Boolean(list.urls) });
      continue;
    }
    const parsed = parseFilterList(await readFile(file, 'utf8'));
    const bucket = acc[list.category];
    bucket.network.push(...parsed.network);
    bucket.cosmetic.push(...parsed.cosmetic);
    bucket.directives.push(...parsed.directives);
    scriptlets.push(...parsed.scriptlets);
    listsMeta.push({
      id: list.id,
      title: list.title,
      category: list.category,
      present: true,
      external: Boolean(list.urls),
      network: parsed.network.length,
      cosmetic: parsed.cosmetic.length + parsed.directives.length,
      scriptlets: parsed.scriptlets.length,
      unsupported: parsed.unsupported,
    });
    console.log(`  ${list.title.padEnd(42)} сеть ${fmt(parsed.network.length).padStart(7)}  косметика ${fmt(parsed.cosmetic.length).padStart(7)}  скриптлеты ${fmt(parsed.scriptlets.length).padStart(5)}  пропущено ${fmt(parsed.unsupported).padStart(6)}`);
  }

  await mkdir(path.join(EXT, 'rules'), { recursive: true });
  await mkdir(path.join(EXT, 'data'), { recursive: true });

  // Сетевые правила: у каждой категории свой набор, его можно включать и выключать отдельно.
  const rulesMeta = {};
  for (const category of CATEGORIES) {
    const { rules, stats } = compileNetwork(acc[category].network, { maxRules: config.budget[category], neuter: category !== 'annoyances' });
    for (const rule of rules) {
      if (rule.action.type !== 'redirect') continue;
      const file = rule.action.redirect.extensionPath.replace(/^\//, '');
      if (!existsSync(path.join(EXT, file))) throw new Error(`Нет файла для redirect: ${file}`);
    }
    await writeFile(path.join(EXT, 'rules', `${category}.json`), JSON.stringify(rules));
    rulesMeta[category] = { rules: stats.rules, dropped: stats.dropped };
    const dropped = stats.dropped ? ` (не влезло в бюджет: ${fmt(stats.dropped)})` : '';
    console.log(`→ rules/${category}.json: ${fmt(stats.rules)} правил${dropped}`);
  }

  // Косметика: реклама и трекеры вместе, раздражители отдельно (включаются настройкой).
  const cosmeticAds = compileCosmetic(
    [...acc.ads.cosmetic, ...acc.trackers.cosmetic],
    [...acc.ads.directives, ...acc.trackers.directives],
  );
  const cosmeticAnnoyances = compileCosmetic(acc.annoyances.cosmetic, acc.annoyances.directives);
  const cosmeticStats = (d) => ({
    keyed: Object.values(d.generic.keyed).reduce((n, l) => n + l.length, 0),
    broad: d.generic.broad.length,
    sites: Object.keys(d.specific).length,
    specific: Object.values(d.specific).reduce((n, l) => n + l.length, 0),
  });
  await writeFile(path.join(EXT, 'data', 'cosmetic-ads.json'), JSON.stringify(cosmeticAds));
  await writeFile(path.join(EXT, 'data', 'cosmetic-annoyances.json'), JSON.stringify(cosmeticAnnoyances));
  const cAds = cosmeticStats(cosmeticAds);
  console.log(`→ data/cosmetic-ads.json: общих ${fmt(cAds.keyed + cAds.broad)}, для ${fmt(cAds.sites)} сайтов ${fmt(cAds.specific)}`);

  // Скриптлеты: один файл для MAIN-мира с таблицей «сайт → скриптлеты» и их реализацией.
  // Регистрируется только для сайтов из таблицы (сущности вида example.* в match-паттерны не укладываются).
  const { table, stats: sStats } = compileScriptlets(scriptlets, { entities: false });
  const generated = `/* Сгенерировано tools/build.mjs из списков фильтров — не редактировать вручную. */
(() => {
  'use strict';
  const TABLE = ${JSON.stringify(table)};
  const entries = (${lookupScriptlets.toString()})(TABLE, location.hostname);
  if (entries.length) (${runScriptlets.toString()})(entries);
})();
`;
  await mkdir(path.join(EXT, 'generated'), { recursive: true });
  await writeFile(path.join(EXT, 'generated', 'scriptlets.js'), generated);
  const matches = Object.keys(table.hosts).map((h) => (/^\d+(?:\.\d+){3}$/.test(h) ? `*://${h}/*` : `*://*.${h}/*`));
  await writeFile(path.join(EXT, 'data', 'scriptlets.json'), JSON.stringify({ matches }));
  console.log(`→ generated/scriptlets.js: ${fmt(sStats.entries)} скриптлетов для ${fmt(sStats.hosts)} сайтов${sStats.skipped ? ` (пропущено ${fmt(sStats.skipped)})` : ''}`);

  const meta = {
    version: manifest.version,
    builtAt: new Date().toISOString(),
    lists: listsMeta,
    rules: rulesMeta,
    scriptlets: sStats,
    cosmetic: { ads: cAds, annoyances: cosmeticStats(cosmeticAnnoyances) },
    redirects: [...new Set(Object.values(REDIRECT_RESOURCES))],
  };
  await writeFile(path.join(EXT, 'data', 'meta.json'), JSON.stringify(meta, null, 2));
  console.log('Готово.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
