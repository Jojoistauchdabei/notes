/* Federwerk Autoupdate-Banner (Web + Tauri-Android).
 *
 * Desktop (Linux/Windows): Update läuft nativ in Rust (src-tauri/src/lib.rs
 * via tauri-plugin-updater gegen latest.json) – dieses Skript zeigt dort nur
 * einen Hinweis-Banner. Android-APK (GitHub-Releases, kein Play Store) und
 * Web/PWA: Prüfung gegen die GitHub-Releases-API, Banner mit Aktion.
 *
 * Kein Build nötig, keine Dependencies. Intervall: max. 1 Check / 24 h
 * (localStorage), ausgelöst verzögert nach Seitenstart + manuell über
 * window.FederwerkUpdate.check().
 */
(function () {
  'use strict';
  var REPO = 'Jojoistauchdabei/notes';
  var API_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var CHECK_KEY = 'federwerk-update-last-check';
  var SEEN_KEY = 'federwerk-update-seen';
  var DAY_MS = 24 * 60 * 60 * 1000;

  function isTauri() {
    try {
      return (
        typeof window.__TAURI__ !== 'undefined' ||
        typeof window.__TAURI_INTERNALS__ !== 'undefined' ||
        (navigator.userAgent && navigator.userAgent.indexOf('Tauri') !== -1)
      );
    } catch (e) {
      return false;
    }
  }

  function isAndroid() {
    try {
      return /android/i.test(navigator.userAgent || '');
    } catch (e) {
      return false;
    }
  }

  function cmpVersions(a, b) {
    function parts(v) {
      return String(v || '').replace(/^v/, '').split('.').map(function (x) {
        var n = parseInt(x, 10);
        return isNaN(n) ? 0 : n;
      });
    }
    var pa = parts(a), pb = parts(b);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  function currentVersion() {
    // 1) version-tag im Header ("v1.7.2 · BUILD …"), 2) Manifest, 3) Fallback.
    try {
      var tag = document.querySelector('.version-tag');
      var m = tag && tag.textContent.match(/v(\d+\.\d+\.\d+)/);
      if (m) return m[1];
    } catch (e) {}
    return '0.0.0';
  }

  function showBanner(html) {
    if (document.getElementById('fw-update-banner')) return;
    var bar = document.createElement('div');
    bar.id = 'fw-update-banner';
    bar.setAttribute('role', 'status');
    bar.style.cssText =
      'position:sticky;top:0;z-index:9999;display:flex;gap:10px;align-items:center;' +
      'justify-content:center;flex-wrap:wrap;padding:8px 12px;font-size:14px;' +
      'background:#3b2b1a;color:#faf6ee;border-bottom:2px solid #8b5a2b;';
    bar.innerHTML = html;
    var close = document.createElement('button');
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Update-Hinweis schließen');
    close.style.cssText =
      'background:transparent;border:1px solid #faf6ee;color:#faf6ee;' +
      'border-radius:6px;padding:2px 8px;cursor:pointer;';
    close.onclick = function () { bar.remove(); };
    bar.appendChild(close);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  function bannerFor(release, latest, current) {
    var tag = release.tag_name || ('v' + latest);
    if (isTauri() && !isAndroid()) {
      showBanner('<span>⬆ Federwerk <b>' + tag + '</b> verfügbar – Update wird im Hintergrund geladen, danach startet die App neu.</span>');
      return;
    }
    var apk = null;
    try {
      (release.assets || []).forEach(function (a) {
        if (/\.apk$/i.test(a.name || '') && (!apk || /universal/i.test(a.name))) apk = a;
      });
      if (!apk) (release.assets || []).forEach(function (a) { if (!apk && /\.apk$/i.test(a.name || '')) apk = a; });
    } catch (e) {}
    if (apk) {
      showBanner(
        '<span>⬆ Federwerk <b>' + tag + '</b> verfügbar (installiert: v' + current + ').</span>' +
        '<a href="' + apk.browser_download_url + '" style="color:#ffd98a;font-weight:bold">APK laden &amp; installieren</a>'
      );
      return;
    }
    if (isTauri()) {
      showBanner('<span>⬆ Federwerk <b>' + tag + '</b> verfügbar – siehe GitHub-Releases.</span>');
      return;
    }
    showBanner(
      '<span>⬆ Federwerk <b>' + tag + '</b> verfügbar (diese Seite: v' + current + ').</span>' +
      '<button id="fw-update-reload" style="background:#8b5a2b;border:none;color:#fff;border-radius:6px;padding:4px 12px;cursor:pointer">Neu laden</button>'
    );
    var btn = document.getElementById('fw-update-reload');
    if (btn) btn.onclick = function () {
      try {
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations().then(function (rs) {
            rs.forEach(function (r) { r.update(); });
            location.reload();
          }).catch(function () { location.reload(); });
        } else location.reload();
      } catch (e) { location.reload(); }
    };
  }

  function check(force) {
    if (!navigator.onLine) return Promise.resolve(null);
    try {
      var last = parseInt(localStorage.getItem(CHECK_KEY) || '0', 10);
      if (!force && Date.now() - last < DAY_MS) return Promise.resolve(null);
    } catch (e) {}
    return fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (rel) {
        try { localStorage.setItem(CHECK_KEY, String(Date.now())); } catch (e) {}
        var latest = String(rel.tag_name || rel.name || '').replace(/^v/, '');
        if (!/^\d+\.\d+\.\d+/.test(latest)) return null;
        var cur = currentVersion();
        if (cmpVersions(cur, latest) >= 0) return null;
        try {
          var seen = localStorage.getItem(SEEN_KEY);
          if (!force && seen === rel.tag_name) return null;
        } catch (e) {}
        bannerFor(rel, latest, cur);
        return rel;
      })
      .catch(function () { return null; });
  }

  window.FederwerkUpdate = {
    check: function () { return check(true); },
    checkAuto: function () { return check(false); }
  };

  // Verzögerter Autocheck, damit der App-Start nicht blockiert.
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(function () { check(false); }, 6000);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(function () { check(false); }, 6000);
    });
  }
})();
