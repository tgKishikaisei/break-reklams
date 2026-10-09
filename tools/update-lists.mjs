#!/usr/bin/env node
/**
 * Скачивает большие внешние списки (EasyList, EasyPrivacy, AdGuard Russian, …) в filters/external/
 * и пересобирает правила. Если какой-то список недоступен — остаётся предыдущая версия.
 *   npm run update
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILTERS = path.join(ROOT, 'filters');

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'BreakReklams-updater' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('!')).length;
  if (lines < 50) throw new Error('подозрительно короткий список');
  return { text, lines };
}

const config = JSON.parse(await readFile(path.join(FILTERS, 'lists.json'), 'utf8'));
await mkdir(path.join(FILTERS, 'external'), { recursive: true });

for (const list of config.lists.filter((l) => l.urls)) {
  let done = false;
  for (const url of list.urls) {
    try {
      const { text, lines } = await download(url);
      await writeFile(path.join(FILTERS, list.file), text);
      console.log(`✓ ${list.title}: ${lines.toLocaleString('ru-RU')} строк`);
      done = true;
      break;
    } catch (err) {
      console.warn(`  ${list.title}: ${url} — ${err.message}`);
    }
  }
  if (!done) console.warn(`✗ ${list.title}: не удалось скачать, оставлена прежняя версия (если была)`);
}

console.log('\nСборка правил…');
await import(pathToFileURL(path.join(ROOT, 'tools', 'build.mjs')).href);
