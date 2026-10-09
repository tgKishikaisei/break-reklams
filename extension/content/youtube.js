/**
 * Break Reklams — YouTube, изолированный мир.
 * Страховка на случай, если реклама всё-таки прорвалась в плеер:
 * глушит звук, проматывает ролик до конца, жмёт «Пропустить»,
 * закрывает окно «Блокировщики рекламы нарушают Условия использования».
 */
(() => {
  'use strict';
  if (window.__brYouTube) return;
  window.__brYouTube = true;

  const SKIP_BUTTONS = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-slot button',
    '.ytp-ad-overlay-close-button',
  ].join(',');

  let beforeAd = null; // звук и скорость, которые были до рекламы
  let userRate = 1;

  try {
    chrome.runtime.sendMessage({ type: 'youtube:check' })
      .then((res) => { if (res?.active) setInterval(tick, 250); })
      .catch(() => {});
  } catch {
    // расширение перезагружено
  }

  function tick() {
    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    const video = player && (player.querySelector('video.html5-main-video') || player.querySelector('video'));
    const inAd = Boolean(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));

    if (inAd && video) {
      beforeAd ??= { muted: video.muted, rate: userRate };
      video.muted = true;
      if (video.playbackRate !== 16) video.playbackRate = 16;
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
        video.currentTime = video.duration - 0.05;
      }
      for (const button of document.querySelectorAll(SKIP_BUTTONS)) button.click();
    } else if (video) {
      if (beforeAd) {
        video.muted = beforeAd.muted;
        video.playbackRate = beforeAd.rate;
        beforeAd = null;
      } else {
        userRate = video.playbackRate || 1;
      }
    }

    closeEnforcementDialog(video);
  }

  function closeEnforcementDialog(video) {
    const message = document.querySelector('ytd-enforcement-message-view-model');
    if (!message) return;
    (message.closest('tp-yt-paper-dialog') || message).remove();
    for (const backdrop of document.querySelectorAll('tp-yt-iron-overlay-backdrop')) backdrop.remove();
    if (video && video.paused) video.play().catch(() => {});
  }
})();
