#!/usr/bin/env node
/**
 * hosts-файл для браузеров без расширений (DuckDuckGo и др.):
 *   dist/hosts/break-reklams-hosts.txt   — список «0.0.0.0 домен»
 *   dist/hosts/install-hosts.cmd         — установка (двойной клик, попросит права администратора)
 *   dist/hosts/uninstall-hosts.cmd       — удаление
 * Берёт домены из тех же списков фильтров, что и расширение (+ filters/hosts-extra.txt).
 *   npm run hosts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_RE, parseFilterList } from '../extension/lib/abp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILTERS = path.join(ROOT, 'filters');
const OUT = path.join(ROOT, 'dist', 'hosts');
const MAX_HOSTS = 80_000; // очень большие hosts-файлы замедляют службу DNS в Windows

// Без заглушек, которые есть в расширении, блокировка этих доменов ломает сайты.
const NEVER = new Set(['googletagmanager.com', 'www.googletagmanager.com', 'imasdk.googleapis.com']);

const config = JSON.parse(readFileSync(path.join(FILTERS, 'lists.json'), 'utf8'));
const blocked = new Set();
const allowed = new Set();

for (const list of config.lists) {
  if (list.category === 'annoyances') continue;
  const file = path.join(FILTERS, list.file);
  if (!existsSync(file)) continue;
  for (const f of parseFilterList(readFileSync(file, 'utf8')).network) {
    if (!f.domainHost) continue;
    if (f.exception) {
      allowed.add(f.domainHost);
      continue;
    }
    // hosts не умеет условий: берём только безусловную блокировку домена (и поп-андер сети).
    const conditional = f.initiatorDomains.length || f.excludedInitiatorDomains.length || f.party
      || f.requestDomains.length || f.excludedRequestDomains.length || f.redirect || f.methods.length || f.notMethods.length;
    const onlyPopup = f.resolvedTypes.size === 1 && f.resolvedTypes.has('main_frame');
    if (conditional || (f.resolvedTypes.size && !onlyPopup) || f.notTypes.size) continue;
    blocked.add(f.domainHost);
  }
}

for (const line of readFileSync(path.join(FILTERS, 'hosts-extra.txt'), 'utf8').split(/\r?\n/)) {
  const host = line.replace(/#.*/, '').trim().toLowerCase();
  if (host && HOST_RE.test(host)) blocked.add(host);
}
for (const host of [...blocked]) if (host.split('.').length === 2) blocked.add(`www.${host}`);

const isAllowed = (host) => [...allowed].some((a) => host === a || host.endsWith(`.${a}`));
const hosts = [...blocked].filter((h) => !NEVER.has(h) && !isAllowed(h)).sort().slice(0, MAX_HOSTS);

mkdirSync(OUT, { recursive: true });
const header = [
  '# Break Reklams hosts blocklist',
  `# Generated ${new Date().toISOString().slice(0, 10)}, ${hosts.length} domains.`,
  '# Installed by install-hosts.cmd, removed by uninstall-hosts.cmd.',
  '',
];
writeFileSync(path.join(OUT, 'break-reklams-hosts.txt'), `${[...header, ...hosts.map((h) => `0.0.0.0 ${h}`)].join('\r\n')}\r\n`);

// PowerShell 5.1 читает скрипты без BOM в кодировке ANSI — сохраняем с BOM, чтобы русский текст не испортился.
const withBom = (text) => String.fromCharCode(0xfeff) + text.replace(/\n/g, '\r\n');

const common = `param([string]$HostsPath = "$env:SystemRoot\\System32\\drivers\\etc\\hosts")
$ErrorActionPreference = 'Stop'
$SystemHosts = "$env:SystemRoot\\System32\\drivers\\etc\\hosts"
$Begin = '# >>> Break Reklams >>>'
$End = '# <<< Break Reklams <<<'
$Utf8 = New-Object System.Text.UTF8Encoding $false

# Права администратора нужны только для настоящего hosts (параметр -HostsPath — для проверки на копии).
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($HostsPath -eq $SystemHosts -and -not $isAdmin) {
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File \`"$PSCommandPath\`""
  exit
}

function Remove-Block([string]$text) {
  $pattern = '(?s)(\\r?\\n)*' + [regex]::Escape($Begin) + '.*?' + [regex]::Escape($End) + '(\\r?\\n)*'
  return ([regex]::Replace($text, $pattern, "\`r\`n")).TrimEnd()
}
`;

writeFileSync(path.join(OUT, 'install-hosts.ps1'), withBom(`${common}
$source = Join-Path $PSScriptRoot 'break-reklams-hosts.txt'
if (-not (Test-Path $source)) { throw "Не найден $source" }
$backup = "$HostsPath.break-reklams.bak"
if (-not (Test-Path $backup)) { Copy-Item $HostsPath $backup }

$current = if (Test-Path $HostsPath) { [IO.File]::ReadAllText($HostsPath) } else { '' }
$list = ([IO.File]::ReadAllText($source)).Trim()
$result = (Remove-Block $current) + "\`r\`n\`r\`n$Begin\`r\`n$list\`r\`n$End\`r\`n"
[IO.File]::WriteAllText($HostsPath, $result.TrimStart(), $Utf8)
if ($HostsPath -eq $SystemHosts) { ipconfig /flushdns | Out-Null }

$count = ($list -split "\`n" | Where-Object { $_ -like '0.0.0.0 *' }).Count
Write-Host ''
Write-Host "Готово: заблокировано доменов — $count." -ForegroundColor Green
Write-Host 'Перезапустите браузер. Резервная копия прежнего hosts:' $backup
if ($HostsPath -eq $SystemHosts) { Write-Host ''; Read-Host 'Нажмите Enter, чтобы закрыть окно' }
`));

writeFileSync(path.join(OUT, 'uninstall-hosts.ps1'), withBom(`${common}
if (-not (Test-Path $HostsPath)) { exit }
$current = [IO.File]::ReadAllText($HostsPath)
[IO.File]::WriteAllText($HostsPath, (Remove-Block $current) + "\`r\`n", $Utf8)
if ($HostsPath -eq $SystemHosts) { ipconfig /flushdns | Out-Null }
Write-Host ''
Write-Host 'Готово: блокировка Break Reklams удалена из hosts.' -ForegroundColor Green
if ($HostsPath -eq $SystemHosts) { Write-Host ''; Read-Host 'Нажмите Enter, чтобы закрыть окно' }
`));

const cmd = (script) => `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${script}"\r\n`;
writeFileSync(path.join(OUT, 'install-hosts.cmd'), cmd('install-hosts.ps1'));
writeFileSync(path.join(OUT, 'uninstall-hosts.cmd'), cmd('uninstall-hosts.ps1'));

console.log(`→ dist/hosts/break-reklams-hosts.txt: ${hosts.length} доменов${blocked.size > MAX_HOSTS ? ` (обрезано до ${MAX_HOSTS})` : ''}`);
console.log('→ dist/hosts/install-hosts.cmd, uninstall-hosts.cmd');
