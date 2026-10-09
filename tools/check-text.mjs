#!/usr/bin/env node
/**
 * Проверка «гигиены» текстовых файлов проекта:
 *   • невидимые символы (zero-width, мягкий перенос, BOM, управление направлением текста — «Trojan Source»);
 *   • нестандартные пробелы (неразрывный, узкий, полноширинный и т. п.);
 *   • пробелы и табы в конце строк, переводы строк Windows (CRLF), лишние пустые строки в конце файла.
 *
 *   npm run lint:text           — только отчёт (код выхода 1, если есть проблемы)
 *   npm run lint:text -- --fix  — исправить на месте
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = process.argv.includes('--fix');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'external', 'rules', 'data', 'generated']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml', '.svg']);
const TEXT_NAMES = new Set(['.gitignore', '.gitattributes', '.editorconfig', 'LICENSE']);

// Символы заданы числовыми кодами: в исходнике этого файла самих невидимых символов быть не должно.
const range = (from, to = from) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
// Невидимые и «форматирующие» символы — удаляются.
const INVISIBLE = new Set([
  0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, ...range(0x180b, 0x180f),
  ...range(0x200b, 0x200f), ...range(0x202a, 0x202e), ...range(0x2060, 0x2064), ...range(0x2066, 0x206f),
  0x3164, ...range(0xfe00, 0xfe0f), 0xfeff, 0xffa0, ...range(0xfff9, 0xfffb), ...range(0xe0000, 0xe007f),
]);
// Нестандартные пробелы — заменяются обычным.
const ODD_SPACE = new Set([0x00a0, 0x1680, ...range(0x2000, 0x200a), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);

const kindOf = (ch) => {
  const cp = ch.codePointAt(0);
  return INVISIBLE.has(cp) ? 'invisible' : ODD_SPACE.has(cp) ? 'space' : null;
};

function clean(text) {
  let out = '';
  for (const ch of text) {
    const kind = kindOf(ch);
    out += kind === 'invisible' ? '' : kind === 'space' ? ' ' : ch;
  }
  return out;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(full);
    const ext = path.extname(entry.name).toLowerCase();
    return TEXT_EXT.has(ext) || TEXT_NAMES.has(entry.name) ? [full] : [];
  });
}

const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

let problems = 0;
let fixedFiles = 0;

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const original = readFileSync(file, 'utf8');
  const issues = [];

  original.split('\n').forEach((line, i) => {
    let col = 0;
    for (const ch of line) {
      col++;
      const kind = kindOf(ch);
      if (kind) issues.push(`${i + 1}:${col} ${kind === 'invisible' ? 'невидимый символ' : 'нестандартный пробел'} ${hex(ch)}`);
    }
    if (line.endsWith('\r')) issues.push(`${i + 1} перевод строки CRLF`);
    if (/[ \t]+\r?$/.test(line)) issues.push(`${i + 1} пробелы в конце строки`);
  });
  if (original.length && !original.endsWith('\n')) issues.push('нет перевода строки в конце файла');
  if (/\n\s*\n$/.test(original)) issues.push('лишние пустые строки в конце файла');

  if (!issues.length) continue;
  problems += issues.length;

  if (FIX) {
    const fixed = `${clean(original)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\s+$/, '')}\n`;
    writeFileSync(file, fixed);
    fixedFiles++;
    console.log(`исправлено: ${rel} (${issues.length})`);
  } else {
    for (const issue of issues.slice(0, 20)) console.log(`${rel}:${issue}`);
    if (issues.length > 20) console.log(`${rel}: … и ещё ${issues.length - 20}`);
  }
}

if (!problems) console.log('Текст чистый: невидимых символов, лишних пробелов и CRLF нет.');
else if (FIX) console.log(`\nИсправлено файлов: ${fixedFiles}, проблем: ${problems}.`);
else {
  console.log(`\nНайдено проблем: ${problems}. Исправить: npm run lint:text -- --fix`);
  process.exitCode = 1;
}
