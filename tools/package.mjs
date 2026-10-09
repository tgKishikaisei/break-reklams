#!/usr/bin/env node
/**
 * Упаковка расширения:
 *   dist/firefox/                     — версия для Firefox (свой manifest.json)
 *   dist/break-reklams-chrome.zip     — для Chrome / Edge / Яндекс.Браузера / Opera
 *   dist/break-reklams-firefox.zip    — для Firefox (about:debugging или addons.mozilla.org)
 *   npm run package
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBrowserMetadata, zipDirectory } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const FIREFOX = path.join(DIST, 'firefox');

/** Манифест Chrome → манифест Firefox. */
function toFirefoxManifest(chrome) {
  const m = structuredClone(chrome);
  // Firefox запускает фон как event page (background.scripts), а не как service worker.
  m.background = { scripts: [chrome.background.service_worker], type: 'module' };
  delete m.minimum_chrome_version;
  m.browser_specific_settings = {
    gecko: {
      id: 'break-reklams@break-reklams.local',
      // world: 'MAIN' в scripting.registerContentScripts — с Firefox 128
      strict_min_version: '128.0',
      data_collection_permissions: { required: ['none'] },
    },
  };
  m.content_scripts = m.content_scripts.map(({ match_origin_as_fallback, ...rest }) => rest);
  return m;
}

const chromeManifest = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

rmSync(FIREFOX, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

cpSync(EXT, FIREFOX, {
  recursive: true,
  filter: (src) => !isBrowserMetadata(path.relative(EXT, src).split(path.sep).join('/')),
});
writeFileSync(path.join(FIREFOX, 'manifest.json'), `${JSON.stringify(toFirefoxManifest(chromeManifest), null, 2)}\n`);

const version = chromeManifest.version;
const chromeZip = zipDirectory(EXT);
const firefoxZip = zipDirectory(FIREFOX);
writeFileSync(path.join(DIST, 'break-reklams-chrome.zip'), chromeZip);
writeFileSync(path.join(DIST, 'break-reklams-firefox.zip'), firefoxZip);

const kb = (b) => `${Math.round(b.length / 1024)} КБ`;
console.log(`Break Reklams ${version}`);
console.log(`→ dist/firefox/                   папка для Firefox (about:debugging → «Загрузить временное дополнение» → manifest.json)`);
console.log(`→ dist/break-reklams-chrome.zip   ${kb(chromeZip)}`);
console.log(`→ dist/break-reklams-firefox.zip  ${kb(firefoxZip)}`);
