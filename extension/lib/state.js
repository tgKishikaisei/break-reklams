/**
 * Break Reklams — настройки и общие хелперы (service worker, popup, страница настроек).
 */

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true, // главный выключатель
  trackers: true, // блокировать трекеры и аналитику
  youtube: true, // вырезать рекламу на YouTube
  videoAds: true, // вырезать рекламу из видеоплееров на сайтах (VAST/VMAP)
  popups: true, // закрывать рекламные всплывающие окна
  antiAdblock: true, // убирать окна «отключите AdBlock»
  annoyances: false, // прятать cookie-баннеры
});

export async function loadState() {
  const s = await chrome.storage.local.get(['settings', 'allowlist', 'userFilters']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    allowlist: Array.isArray(s.allowlist) ? s.allowlist : [],
    userFilters: typeof s.userFilters === 'string' ? s.userFilters : '',
  };
}

/** Хост веб-страницы по URL; пустая строка для chrome://, file:// и т. п. */
export function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return /^(?:https?|wss?):$/.test(u.protocol) ? u.hostname : '';
  } catch {
    return '';
  }
}

/** `https://www.Example.com/path` или `example.com` → `example.com`. null — если это не хост. */
export function normalizeHost(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  try {
    const host = new URL(s).hostname.replace(/\.$/, '').replace(/^www\./, '');
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

export const isIPv4 = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

/** Доступ ко всем сайтам. В Chrome выдаётся при установке, в Firefox его иногда нужно разрешить вручную. */
export const SITE_ACCESS = { origins: ['<all_urls>'] };
export async function hasSiteAccess() {
  try {
    return await chrome.permissions.contains(SITE_ACCESS);
  } catch {
    return true;
  }
}

export function isAllowlisted(host, allowlist) {
  if (!host) return false;
  return allowlist.some((d) => host === d || host.endsWith(`.${d}`));
}
