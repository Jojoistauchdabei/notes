'use strict';
/* Federwerk: Live-Benachrichtigungen (Server-Sent Events).
 *
 * Warum SSE und nicht WebSocket: der alte Weg hatte zwei handgebaute
 * Sockets mit eigenem Auth-Frame, eigenem Ping und eigenem Reconnect. SSE
 * braucht davon nichts - reconnect, Last-Event-ID und die HTTP-Semantik sind
 * schon drin. Ausserdem ist die Verbindung in
 * eine Richtung, was hier genau der Fall ist: der Server sagt "da ist etwas
 * neu", der Client holt den Delta-Pull ueber normales HTTP.
 *
 * Die Absicht ist bewusst conservative: Ein Ereignis traegt KEINE Nutzdaten,
 * sondern nur den Hinweis "Zieh nach". Damit kann ein falsch zugeordneter
 * Kanal keine fremden Inhalte ausspucken, und die Client-Seite braucht
 * weiterhin genau den einen Pull-Pfad, den sie schon hat.
 */

const clients = new Set();
let nextId = 1;

/* Wer schaut auf welche Freigabe? Ohne das kaeme eine Benachrichtigung nur
 * beim Besitzer an, und Gaeste saehen neue Striche erst beim naechsten Poll -
 * bei Liveshare genau das, was man nicht will. Der Client nennt die
 * Freigabe beim Abonnieren, und der Aufrufer hat sie vorher mit readShare()
 * geprueft: hier steht also kein ungepruefter Code aus dem Browser. */
const watch = new Map(); // shareId -> Set(userId)

function addWatch(shareId, userId) {
  if (!watch.has(shareId)) watch.set(shareId, new Set());
  watch.get(shareId).add(userId);
}

function removeWatch(shareId, userId) {
  const s = watch.get(shareId);
  if (s) { s.delete(userId); if (!s.size) watch.delete(shareId); }
}

/* Alle angemeldeten Nutzer, die diese Freigabe offen haben. */
function notifyShare(shareId, userId) {
  const watchers = watch.get(shareId);
  if (!watchers || !watchers.size) return 0;
  const self = userId;
  let n = 0;
  // Auch der Absender sieht sein eigenes Ereignis nicht ueber den Kanal -
  // er hat es gerade geschrieben, und ein Echo erzeugt bei jedem Strich eine
  // zweite, identische Zeichnung auf dem Sendegerät.
  const targets = [...watchers].filter((u) => u !== self);
  for (const u of targets) n += notify(u, ['share_events'], shareId);
  return n;
}

function subscribe(res, userId, channels, shareId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Nginx/Tunnel duerfen den Strom nicht puffern
  });
  res.write('retry: 5000\n\n');

  const client = { id: nextId++, res, userId, channels, shareId: shareId || null, alive: true };
  clients.add(client);
  if (client.shareId) addWatch(client.shareId, userId);

  // Kommentarzeilen halten die Verbindung durch Proxys und Tunnel offen.
  const beat = setInterval(() => {
    if (!client.alive) return;
    try { res.write(': ping\n\n'); } catch { drop(client); }
  }, 25000);

  const cleanup = () => { clearInterval(beat); drop(client); };
  res.on('close', cleanup);
  res.on('error', cleanup);
  return client;
}

function drop(client) {
  client.alive = false;
  clients.delete(client);
  if (client.shareId) removeWatch(client.shareId, client.userId);
  try { client.res.end(); } catch { /* ignore */ }
}

/* An alle Clients eines Nutzers melden, auf denen der Kanal offen ist.
 * Fremde Nutzer werden nie erreicht - die Kanalzuordnung ist Teil des
 * subscribe-Aufrufs, nicht eine Filterung am Ende. */
function notify(userId, channels, shareId) {
  let n = 0;
  for (const c of [...clients]) {
    if (!c.alive || c.userId !== userId) continue;
    if (shareId && c.shareId && c.shareId !== shareId) continue;
    if (!channels.some((ch) => c.channels.includes(ch) || c.channels.includes('*'))) continue;
    try {
      const payload = JSON.stringify({ channels, at: Date.now() });
      c.res.write(`event: change\ndata: ${payload}\n\n`);
      n++;
    } catch {
      drop(c);
    }
  }
  return n;
}

const stats = () => ({ clients: clients.size, watching: watch.size });

const shutdown = () => { for (const c of [...clients]) drop(c); watch.clear(); };

module.exports = { subscribe, notify, notifyShare, stats, shutdown };