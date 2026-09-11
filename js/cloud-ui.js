/* Grimoire Cloud UI – dünne Schicht über GrimoireCloud (js/cloud.js). */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function readForm() {
    return {
      baseUrl: ($('cloudUrl') && $('cloudUrl').value || '').trim(),
      username: ($('cloudUser') && $('cloudUser').value || '').trim(),
      password: ($('cloudPass') && $('cloudPass').value || ''),
      folder: ($('cloudFolder') && $('cloudFolder').value || 'Grimoire').trim() || 'Grimoire',
      autoSync: !!($('cloudAuto') && $('cloudAuto').checked),
    };
  }
  function fillForm(cfg) {
    if ($('cloudUrl')) $('cloudUrl').value = cfg.baseUrl || '';
    if ($('cloudUser')) $('cloudUser').value = cfg.username || '';
    if ($('cloudPass')) $('cloudPass').value = cfg.password || '';
    if ($('cloudFolder')) $('cloudFolder').value = cfg.folder || 'Grimoire';
    if ($('cloudAuto')) $('cloudAuto').checked = !!cfg.autoSync;
  }
  function msg(t, isErr) {
    const el = $('cloudMsg');
    if (el) { el.textContent = t; el.style.color = isErr ? '#a33' : ''; }
    setStatus(t);
  }
  function setStatus(t) {
    const el = $('cloudStatus');
    if (el) el.textContent = t;
    const s = $('statusSave');
    if (s && /sync|cloud|☁/i.test(t)) s.textContent = t;
  }
  function progress(cur, total, label) {
    setStatus('☁ ' + label + ' (' + cur + '/' + total + ')');
  }

  const UI = {
    openSettings() {
      fillForm(window.GrimoireCloud.loadConfig());
      $('cloudOverlay').classList.add('active');
    },
    closeSettings() { $('cloudOverlay').classList.remove('active'); },
    save() {
      const cfg = readForm();
      window.GrimoireCloud.saveConfig(cfg);
      msg(cfg.baseUrl ? '☁ Einstellungen gespeichert.' : '☁ Gespeichert (noch keine URL – Sync deaktiviert).');
      if (!cfg.baseUrl) return;
      UI.closeSettings();
    },
    clear() {
      window.GrimoireCloud.clearConfig();
      fillForm(window.GrimoireCloud.loadConfig());
      msg('☁ Zurückgesetzt – nur noch lokal.');
    },
    async test() {
      const cfg = readForm();
      window.GrimoireCloud.saveConfig(cfg);
      msg('☁ Teste Verbindung …');
      try {
        await window.GrimoireCloud.testConnection(cfg);
        msg('☁ Verbindung ok – Schreiben/Lesen funktioniert.');
      } catch (e) {
        console.warn(e);
        msg('☁ Fehler: ' + e.message + (isCorsLike(e) ? ' (Tipp: meist CORS – siehe Hinweis unten.)' : ''), true);
      }
    },
    async push() {
      try {
        if (!window.GrimoireCloud.isConfigured()) { UI.openSettings(); msg('☁ Erst Server-Daten eintragen.', true); return; }
        setStatus('☁ Lade hoch …');
        const out = await window.GrimoireCloud.pushAll(progress);
        setStatus('☁ Hochgeladen: ' + out.length + ' Buch/Bücher ✓ ' + new Date().toLocaleTimeString('de-DE'));
      } catch (e) {
        if (e && e.code === 'SYNC_BUSY') { setStatus('☁ ' + e.message); return; }
        console.warn(e);
        setStatus('☁ Hochladen fehlgeschlagen: ' + e.message);
        alert('Cloud-Upload fehlgeschlagen:\n' + e.message);
      }
    },
    async pull() {
      try {
        if (!window.GrimoireCloud.isConfigured()) { UI.openSettings(); return; }
        setStatus('☁ Lade herunter …');
        const r = await window.GrimoireCloud.pullAll(progress);
        setStatus(pullSummary(r));
        UI.closeSettings();
      } catch (e) {
        if (e && e.code === 'SYNC_BUSY') { setStatus('☁ ' + e.message); return; }
        console.warn(e);
        setStatus('☁ Herunterladen fehlgeschlagen: ' + e.message);
        alert('Cloud-Download fehlgeschlagen:\n' + e.message);
      }
    },
    async syncNow() {
      try {
        if (!window.GrimoireCloud.isConfigured()) { UI.openSettings(); msg('☁ Erst Server-Daten eintragen, dann Testen.', true); return; }
        setStatus('☁ Synchronisiere …');
        const r = await window.GrimoireCloud.syncAll(progress);
        let s = '☁ Sync fertig: +' + r.pulled.added.length + ' neu, ~' + r.pulled.updated.length + ' upd, ⬆' + r.pushed.length + ' hoch ✓ ' + new Date().toLocaleTimeString('de-DE');
        if (r.pulled.conflicts && r.pulled.conflicts.length) {
          s += ' | ⚠ Konflikt bei: ' + r.pulled.conflicts.join(', ') + ' – als „(Cloud-Konflikt)“-Kopie behalten.';
        }
        setStatus(s);
      } catch (e) {
        if (e && e.code === 'SYNC_BUSY') { setStatus('☁ ' + e.message); return; }
        console.warn(e);
        setStatus('☁ Sync fehlgeschlagen: ' + e.message);
        alert('Cloud-Sync fehlgeschlagen:\n' + e.message + '\n\nBei „Failed to fetch“: CORS prüfen (siehe ☁⚙-Hinweis).');
      }
    },
  };

  function isCorsLike(e) {
    return /failed to fetch|load failed|networkerror|cors|network error/i.test(String((e && e.message) || e));
  }

  function pullSummary(r) {
    let s = '☁ Heruntergeladen: +' + r.added.length + ' neu, ~' + r.updated.length + ' aktualisiert ✓';
    if (r.conflicts && r.conflicts.length) {
      s += ' | ⚠ Konflikt bei: ' + r.conflicts.join(', ') + ' – als „(Cloud-Konflikt)“-Kopie behalten.';
    }
    return s;
  }

  window.GrimoireCloudUI = UI;

  document.addEventListener('DOMContentLoaded', () => {
    try {
      const cfg = window.GrimoireCloud.loadConfig();
      if (cfg.baseUrl && cfg.username) {
        setStatus('☁ Bereit (' + cfg.folder + ' @ ' + cfg.baseUrl.split('/')[2] + ')');
        if (cfg.autoSync) setTimeout(() => UI.syncNow(), 1200);
      }
    } catch { /* ignore */ }
  });
})();
