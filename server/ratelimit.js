'use strict';
/* Federwerk: Ratelimiter fuer Anmeldung und Registrierung.
 *
 * Warum ueberhaupt: scrypt ist absichtlich teuer (N=16384). Genau das macht
 * eine unbegrenzte Zahl von Logins zur Waffe - jeder Versuch bindet den
 * Prozess, und ein Angreifer kann 10.000 Versuche pro Stunde fahren, ohne
 * je ein echtes Passwort zu raten zu muessen. Der Hash verteuigt die
 * Passwoerter, er verteuigt aber nicht den Endpoint.
 *
 * Also: Fehlschlaege zaehlen, nach N Versuchen sperren, Sperrzeit bei
 * wiederholten Sperren verdoppeln (bis zu einem Maximum), und die Map
 * begrenzen, damit ein Angreifer nicht durch Absenden vieler verschiedener
 * E-Mail-Adressen selbst den Speicher des Servers vollschreibt.
 *
 * Bewusste Ungenauigkeit: Der Limiter kennt keine Konten. Ein Aufrufer
 * zaehlt Fehlschlaege pro Schluessel und ruft check() VOR dem Hash auf.
 * Weil "E-Mail unbekannt" und "Passwort falsch" denselben Schluessel
 * betreffen und dieselbe Sperre ausloesen, kann ein Angreifer nicht ueber
 * die Sperrantwort herausfinden, welche Adressen es ueberhaupt gibt.
 *
 * Keine Abhaengigkeiten, CommonJS, und eine injizierbare Uhr (opts.now),
 * damit der Test nicht 60 Sekunden warten muss.
 */

/* Ein Eintrag:
 *   count        aufeinanderfolgende Fehlschlaege (Reset bei Erfolg)
 *   blockedUntil Zeitpunkt, bis zu dem gesperrt ist (0 = frei)
 *   penalties    wie oft schon gesperrt wurde -> exponentielle Stufe
 *   lastSeen     letzte Aktivitaet, damit die Map nicht ewig lebt
 */
const DEFAULTS = {
  limit: 5,            // Fehlversuche bis zur ersten Sperre
  baseMs: 60 * 1000,   // erste Sperrzeit
  factor: 2,           // Verdopplung je weiterer Sperre
  maxMs: 15 * 60 * 1000, // Deckel fuer die Sperrzeit
  maxEntries: 10000,   // harte Obergrenze der Map
  idleMs: 30 * 60 * 1000, // ab wann ein unberuehrter Eintrag sterben darf
  sweepEvery: 64,      // alle N Operationen einmal aufraeumen
};

function createLimiter(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const entries = new Map();
  let ops = 0;

  function penaltyFor(entry) {
    // Stufe 0 -> baseMs, Stufe 1 -> baseMs*factor, ... bis maxMs.
    const raw = o.baseMs * Math.pow(o.factor, entry.penalties);
    return Math.min(o.maxMs, Math.round(raw));
  }

  /* Raeumt tote Eintraege und erzwingt danach die Obergrenze.
   *
   * Die Obergrenze ist der wichtige Teil: `idleMs` allein haelt die Map nur
   * bei geringer Last klein. Wer 10.000 verschiedene Schluessel in einer
   * Minute schickt, hat zwischen zwei Sweeps alle belegt - deshalb wird
   * notfalls hart nach aelterem lastSeen verdraengt. Verliert ein
   * Angreifer damit eine Sperre, ist das akzeptabel; den Prozess mit
   * Millionen Eintraegen zu killen nicht.
   */
  function sweep() {
    const t = now();
    for (const [key, e] of entries) {
      const abgelaufen = !e.blockedUntil || e.blockedUntil <= t;
      if (abgelaufen && t - e.lastSeen > o.idleMs) entries.delete(key);
    }
    trim(t);
  }

  /* Harte Obergrenze: nach dem Sweep koennen es noch mehr geworden sein,
   * gerade weil der aufrufende Eintrag erst danach angelegt wurde. Deshalb
   * wird hier am Schluss noch einmal gekuerzt, damit size() die Zusage
   * wirklich haelt.
   */
  function trim() {
    if (entries.size <= o.maxEntries) return;
    const alt = [...entries.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (let i = 0; i < entries.size - o.maxEntries; i++) entries.delete(alt[i][0]);
  }

  function gc() {
    if (++ops % o.sweepEvery === 0 || entries.size > o.maxEntries) sweep();
  }

  function entryFor(key, create) {
    gc();
    const k = String(key);
    let e = entries.get(k);
    if (!e && create) {
      e = { count: 0, blockedUntil: 0, penalties: 0, lastSeen: now() };
      entries.set(k, e);
      // Der neue Eintrag zaehlt mit - nach dem Einfuegen kuerzen, sonst
      // haelt die Map die Zusage um genau einen Eintrag nicht ein.
      if (entries.size > o.maxEntries) trim();
    }
    if (e) e.lastSeen = now();
    return e;
  }

  /* Darf es noch einmal versucht werden?
   * Bewusst read-only: check() zaehlt nichts. Sonst wuerde schon das
   * Nachsehen der Sperre den Zaehler hochzaehlen und ein Skript, das nur
   * pollt, sich selbst aussperren.
   */
  function check(key) {
    const e = entryFor(key, false);
    if (!e) return { blocked: false, retryAfterMs: 0, count: 0 };
    const t = now();
    const blocked = e.blockedUntil > t;
    return {
      blocked,
      retryAfterMs: blocked ? e.blockedUntil - t : 0,
      count: e.count,
    };
  }

  /* Zaehlt einen Fehlschlag und sperrt bei Bedarf.
   *
   * Eine laufende Sperre wird NICHT verlaengert, sonst koennte ein Skript
   * die eigene Sperre endlos in die Zukunft schieben und den Schluessel
   * dauerhaft unbrauchbar machen (Denial of Service gegen das eigene Konto).
   */
  function fail(key) {
    const e = entryFor(key, true);
    const t = now();
    if (e.blockedUntil > t) return state(e, t);
    e.count += 1;
    if (e.count >= o.limit) {
      e.blockedUntil = t + penaltyFor(e);
      e.penalties += 1;
    }
    return state(e, t);
  }

  function state(e, t) {
    const zeit = t === undefined ? now() : t;
    return {
      blocked: e.blockedUntil > zeit,
      retryAfterMs: e.blockedUntil > zeit ? e.blockedUntil - zeit : 0,
      count: e.count,
      blockedUntil: e.blockedUntil,
    };
  }

  /* Erfolg: Zaehler und Stufe zuruecksetzen. Nach einem echten Login soll
   * der naechste Fehlversuch nicht sofort wieder sperren.
   */
  function ok(key) {
    entries.delete(String(key));
    gc();
  }

  return {
    check, fail, ok, sweep,
    clear: () => entries.clear(),
    size: () => entries.size,
    peek: (key) => state(entryFor(key, false) || { count: 0, blockedUntil: 0, penalties: 0 }),
    /* Nur fuer Tests/Diagnose: Konfiguration sichtbar machen. */
    options: Object.assign({}, o, { now }),
  };
}

module.exports = { createLimiter, DEFAULTS };