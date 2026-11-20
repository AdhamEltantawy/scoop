/* Scoop update notice: tells the Android app when a newer version is out.
 *
 * The app is sideloaded from GitHub Releases, so nothing updates it for you.
 * On launch and when you come back to it, this asks GitHub for the latest
 * release (CI numbers every build and tags it v1.0.<number>, see
 * .github/workflows/android.yml) and, if it's newer than the installed build,
 * offers the release page to download it from. "Later" holds the question for
 * a few days. The web app updates itself (sw.js), so this only runs in the
 * Android app. Offline, or if GitHub doesn't answer, nothing happens.
 */
(() => {
  'use strict';

  const S = window.scoop;
  const core = window.ScoopCore;
  if (!S || !core || !S.isNative || !S.App || !S.App.getInfo) return;

  const REPO = 'AdhamEltantawy/scoop';
  const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
  const ASKED_KEY = 'scoop.updateAsked.v1';
  const CHECK_EVERY_MS = 6 * 3600000;
  const LATER_MS = 3 * 86400000;

  let lastCheck = 0;
  let asking = false;

  function askedAbout() {
    try { return JSON.parse(localStorage.getItem(ASKED_KEY)) || {}; } catch (e) { return {}; }
  }

  function rememberLater(tag) {
    try { localStorage.setItem(ASKED_KEY, JSON.stringify({ tag, at: Date.now() })); } catch (e) { /* asked again next time */ }
  }

  /** Only ever send people to GitHub. */
  function releasePage(release) {
    const url = String(release.html_url || '');
    return url.startsWith(`https://github.com/${REPO}/`) ? url : `https://github.com/${REPO}/releases/latest`;
  }

  function openRelease(url) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.click();
  }

  async function check({ force = false } = {}) {
    if (asking || (!force && Date.now() - lastCheck < CHECK_EVERY_MS)) return;
    lastCheck = Date.now();
    try {
      const info = await S.App.getInfo();
      if (!core.releaseNumber(info.version)) return; // a local build: nothing to compare with
      const res = await fetch(LATEST_URL, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return;
      const release = await res.json();
      if (!core.updateAvailable(info.version, release.tag_name)) return;
      const before = askedAbout();
      if (before.tag === release.tag_name && Date.now() - before.at < LATER_MS) return;

      // Not in the middle of a walk, and not over another question.
      if (document.body.classList.contains('walking') || !document.getElementById('dialog').hidden) { lastCheck = 0; return; }

      asking = true;
      const choice = await S.confirmDialog({
        title: 'A new version of Scoop is out',
        body: `You have ${info.version}; ${String(release.tag_name).replace(/^v/, '')} is ready. Download scoop.apk from the page that opens and install it over this one. Your map and walks stay.`,
        confirm: 'Get the update',
        tone: '',
        cancel: 'Later',
      });
      asking = false;
      if (choice === 'confirm') openRelease(releasePage(release));
      else rememberLater(release.tag_name);
    } catch (err) {
      asking = false; // offline or rate limited: try again next time
      lastCheck = 0;
    }
  }

  setTimeout(check, 4000);
  S.App.addListener('appStateChange', (state) => { if (state && state.isActive) check(); });
})();
