'use strict';
/* LLM-Kartengenerierung gegen die echte SQLite-Schicht: eine neu erzeugte
 * Karte darf nicht doppelt im Deck landen (frueher wurde das Deck mit Karten
 * angelegt und dieselben Karten danach noch einmal angehaengt). */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'federwerk-llm-cards-'));
process.env.FW_DATA_DIR = TMP;
process.env.FW_FILES_DIR = path.join(TMP, 'files');
process.env.FW_ARCHIVE_DIR = path.join(TMP, 'archive');
fs.mkdirSync(process.env.FW_FILES_DIR, { recursive: true });
fs.mkdirSync(process.env.FW_ARCHIVE_DIR, { recursive: true });

const createMcpDeps = require('../server/mcp.js');
const db = require('../server/db.js');

const CARDS_JSON = '[{"front":"F1","back":"A1"},{"front":"F2","back":"A2"}]';

describe('mcp: generate_cards', () => {
  const realFetch = global.fetch;
  const deps = createMcpDeps({ userId: 'u-llm-cards' });

  before(() => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: CARDS_JSON } }] }),
    });
  });

  after(() => {
    global.fetch = realFetch;
    db.closeAll();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('legt ein neues Deck genau einmal mit den Karten an', async () => {
    const res = await deps.generateCards('', { prompt: 'Photosynthese', count: 2 });
    assert.equal(res.created, true);
    assert.equal(res.added, 2);
    const cards = await deps.listCards(res.deckId);
    assert.equal(cards.length, 2, 'keine Duplikate beim neuen Deck');
    assert.deepEqual(cards.map((c) => c.front).sort(), ['F1', 'F2']);
  });

  it('haengt Karten an ein bestehendes Deck an, ohne es zu verdoppeln', async () => {
    const deck = await deps.createDeck({ title: 'Bestehend' });
    const res = await deps.generateCards(deck.id, { prompt: 'Thema', count: 2 });
    assert.equal(res.created, false);
    assert.equal(res.added, 2);
    const cards = await deps.listCards(deck.id);
    assert.equal(cards.length, 2);
  });
});
