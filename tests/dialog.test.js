'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/* Minimal gefälschtes DOM – deckt genau die Fläche ab, die js/dialog.js nutzt:
 * createElement, getElementById, body.appendChild, addEventListener/
 * removeEventListener (+ manuelles Auslösen), classList, style, focus/select. */
function makeFakeDoc() {
  const byId = {};
  function FakeEl(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.style = {};
    this._cls = new Set();
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.type = '';
    this.id = '';
    this.placeholder = '';
    this.maxLength = -1;
  }
  FakeEl.prototype._sync = function () { this.className = Array.from(this._cls).join(' '); };
  Object.defineProperty(FakeEl.prototype, 'classList', {
    get: function () {
      const self = this;
      return {
        add: (c) => { self._cls.add(c); self._sync(); },
        remove: (c) => { self._cls.delete(c); self._sync(); },
        contains: (c) => self._cls.has(c),
      };
    },
  });
  FakeEl.prototype.appendChild = function (c) {
    this.children.push(c);
    if (c && c.id) byId[c.id] = c;
    // Tiefenregistrierung (Overlay wird mit Kindern gebaut)
    if (c && c.children) {
      const walk = (n) => { if (n.id) byId[n.id] = n; (n.children || []).forEach(walk); };
      walk(c);
    }
    return c;
  };
  FakeEl.prototype.addEventListener = function (t, fn) {
    (this.listeners[t] = this.listeners[t] || []).push(fn);
  };
  FakeEl.prototype.removeEventListener = function (t, fn) {
    this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn);
  };
  FakeEl.prototype.setAttribute = function () {};
  FakeEl.prototype.focus = function () { doc.active = this; };
  FakeEl.prototype.select = function () {};
  FakeEl.prototype.remove = function () {};
  FakeEl.prototype.click = function () {
    (this.listeners.click || []).slice().forEach((fn) => fn({ target: this, preventDefault() {} }));
  };
  const doc = {
    _byId: byId,
    _listeners: {},
    active: null,
    createElement: (t) => new FakeEl(t),
    getElementById: (id) => byId[id] || null,
    body: new FakeEl('body'),
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn); },
    key(t, target) {
      (this._listeners.keydown || []).slice().forEach((fn) =>
        fn({ key: t, target: target || null, preventDefault() {} }));
    },
  };
  doc.body.appendChild = FakeEl.prototype.appendChild.bind(doc.body);
  // body-Kinder ebenfalls registrieren
  const origAppend = doc.body.appendChild;
  doc.body.appendChild = function (c) { return origAppend(c); };
  return doc;
}

let D;
let realDoc;

describe('dialog/datei', () => {
  it('lädt ohne DOM (lazy) und exportiert die API', () => {
    delete global.document;
    delete global.window;
    D = require('../js/dialog.js');
    assert.equal(typeof D.confirm, 'function');
    assert.equal(typeof D.prompt, 'function');
    assert.equal(typeof D._reset, 'function');
  });
  it('rejectet ohne DOM statt zu crashen', async () => {
    delete global.document;
    await assert.rejects(() => D.confirm('x'), /kein DOM/);
    await assert.rejects(() => D.prompt('x', 'y'), /kein DOM/);
  });
});

describe('dialog/flows (fake-dom)', () => {
  beforeEach(() => {
    realDoc = global.document;
    global.document = makeFakeDoc();
    delete require.cache[require.resolve('../js/dialog.js')];
    D = require('../js/dialog.js');
  });
  afterEach(() => {
    if (realDoc === undefined) delete global.document;
    else global.document = realDoc;
  });

  it('confirm: OK -> true, Titel/Labels werden gesetzt', async () => {
    const p = D.confirm('Wirklich?', { title: 'T', okLabel: 'Ja!', danger: true });
    const doc = global.document;
    assert.equal(doc.getElementById('fwDlgTitle').textContent, 'T');
    assert.equal(doc.getElementById('fwDlgOk').textContent, 'Ja!');
    assert.ok(doc.getElementById('fwDlgOverlay').classList.contains('active'));
    doc.getElementById('fwDlgOk').click();
    assert.equal(await p, true);
    assert.ok(!doc.getElementById('fwDlgOverlay').classList.contains('active'));
  });
  it('confirm: Abbrechen -> false, Escape -> false', async () => {
    const doc = global.document;
    const p1 = D.confirm('A?');
    doc.getElementById('fwDlgCancel').click();
    assert.equal(await p1, false);
    const p2 = D.confirm('B?');
    doc.key('Escape');
    assert.equal(await p2, false);
  });
  it('prompt: OK gibt Eingabe zurück, Cancel -> null, Enter bestätigt', async () => {
    const doc = global.document;
    const p1 = D.prompt('Name?', 'alt', { title: 'Neu' });
    doc.getElementById('fwDlgInput').value = 'neu';
    doc.getElementById('fwDlgOk').click();
    assert.equal(await p1, 'neu');
    const p2 = D.prompt('Name?', 'alt');
    doc.getElementById('fwDlgCancel').click();
    assert.equal(await p2, null);
    const p3 = D.prompt('Name?', '');
    doc.key('Enter');
    assert.equal(await p3, '');
  });
  it('queue: zweiter Dialog erst nach erstem', async () => {
    const doc = global.document;
    const order = [];
    const p1 = D.confirm('Erster?').then((v) => { order.push('p1:' + v); return v; });
    const p2 = D.confirm('Zweiter?').then((v) => { order.push('p2:' + v); return v; });
    assert.equal(doc.getElementById('fwDlgMsg').textContent, 'Erster?');
    doc.getElementById('fwDlgOk').click();
    assert.equal(await p1, true);
    assert.equal(doc.getElementById('fwDlgMsg').textContent, 'Zweiter?');
    doc.key('Escape');
    assert.equal(await p2, false);
    assert.deepEqual(order, ['p1:true', 'p2:false']);
  });
  it('Klick auf Abdunklung bricht ab', async () => {
    const doc = global.document;
    const p = D.confirm('Weg?');
    const ov = doc.getElementById('fwDlgOverlay');
    (ov.listeners.click || []).slice().forEach((fn) => fn({ target: ov }));
    assert.equal(await p, false);
  });
});
