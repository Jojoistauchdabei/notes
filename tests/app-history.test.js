'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeClassList() {
  const s = new Set();
  return {
    add: (c) => s.add(c),
    remove: (c) => s.delete(c),
    contains: (c) => s.has(c),
    toggle: (c, f) => {
      if (f === undefined) {
        if (s.has(c)) s.delete(c);
        else s.add(c);
      } else if (f) s.add(c);
      else s.delete(c);
    },
    _set: s,
  };
}

function makeCtx2d() {
  return {
    clearRect() {}, save() {}, restore() {}, setTransform() {}, scale() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    arc() {}, fillRect() {}, drawImage() {}, fillText() {}, closePath() {},
    setLineDash() {},
  };
}

function makeEl() {
  return {
    classList: makeClassList(),
    style: {},
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
    getBoundingClientRect: () => ({ width: 200, height: 200, left: 0, top: 0 }),
    getContext: () => makeCtx2d(),
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => {},
    querySelectorAll: () => [],
    focus: () => {},
  };
}

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  const cut = src.indexOf("window.addEventListener('resize'");
  const code = cut === -1 ? src : src.slice(0, cut);
  const listeners = {};
  const added = [];
  const removed = [];
  const els = {};
  const windowStub = {
    devicePixelRatio: 1,
    innerWidth: 1200,
    addEventListener: (t, fn) => {
      (listeners[t] = listeners[t] || []).push(fn);
      added.push(t);
    },
    removeEventListener: (t, fn) => {
      removed.push(t);
      if (!listeners[t]) return;
      listeners[t] = listeners[t].filter((f) => f !== fn);
    },
    _listeners: listeners,
    _added: added,
    _removed: removed,
  };
  const documentStub = {
    getElementById: (id) => (els[id] = els[id] || makeEl()),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener: () => {},
    activeElement: null,
    _els: els,
  };
  const store = {};
  const sandbox = {
    console,
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    setTimeout, clearTimeout,
    document: documentStub,
    window: windowStub,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: {},
    alert: () => {},
    confirm: () => true,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    _windowStub: windowStub,
    _documentStub: documentStub,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const api = `;globalThis.__T = {
    get state() { return state; }, set state(v) { state = v; },
    get split() { return split; },
    get undoStack() { return undoStack; }, set undoStack(v) { undoStack = v; },
    get redoStack() { return redoStack; }, set redoStack(v) { redoStack = v; },
    get tool() { return tool; }, set tool(v) { tool = v; },
    get selectedBox() { return selectedBox; }, set selectedBox(v) { selectedBox = v; },
    get selectedImg() { return selectedImg; }, set selectedImg(v) { selectedImg = v; },
    newBook, openBook, currentPage, historyState, snapshot, restore, moveHistory,
    undo, redo, addPage, duplicatePage, deletePage, makeDraggable, dragText,
    startResize, snapshotOnceDrag, setActivePageId, activePageId, activePaneIdx,
  };`;
  vm.runInContext(code + api, sandbox, { filename: 'app.js' });
  for (const k of ['state', 'split', 'undoStack', 'redoStack', 'tool', 'selectedBox', 'selectedImg']) {
    Object.defineProperty(sandbox, k, {
      configurable: true,
      get: () => sandbox.__T[k],
      set: (v) => { sandbox.__T[k] = v; },
    });
  }
  for (const k of ['newBook', 'openBook', 'currentPage', 'snapshot', 'restore', 'undo', 'redo',
    'addPage', 'duplicatePage', 'deletePage', 'makeDraggable', 'dragText', 'startResize',
    'setActivePageId', 'activePageId']) {
    sandbox[k] = (...a) => sandbox.__T[k](...a);
  }
  sandbox.renderAll = () => {};
  sandbox.persistSoon = () => {};
  sandbox.touchBook = () => {};
  sandbox.renderTextLayer = () => { sandbox._renderTextCalls = (sandbox._renderTextCalls || 0) + 1; };
  sandbox.renderImgLayer = () => { sandbox._renderImgCalls = (sandbox._renderImgCalls || 0) + 1; };
  sandbox._renderTextCalls = 0;
  sandbox._renderImgCalls = 0;
  return sandbox;
}

function T(ctx) { return ctx.__T; }

function freshBook(ctx, pages) {
  const t = T(ctx);
  const b = t.newBook('T');
  b.pages = pages.map((p, i) => ({
    id: 'p' + (i + 1),
    strokes: p.strokes || [],
    texts: p.texts || [],
    images: p.images || [],
    bg: p.bg || null,
  }));
  t.state.books = [b];
  t.state.openBookId = b.id;
  t.state.openPageId = b.pages[0].id;
  t.split.panes = [{ bookId: b.id, pageId: b.pages[0].id }, { bookId: null, pageId: null }];
  t.split.active = 0;
  t.split.enabled = false;
  t.undoStack.length = 0;
  t.redoStack.length = 0;
  t.selectedBox = null;
  t.selectedImg = null;
  return b;
}

function openPage(ctx, pid) {
  const t = T(ctx);
  t.split.panes[0].pageId = pid;
  t.state.openPageId = pid;
  t.undoStack.length = 0;
  t.redoStack.length = 0;
}

function pageIds(ctx) {
  const b = T(ctx).openBook();
  return b.pages.map((p) => p.id);
}

describe('app/history seitenoperationen', () => {
  let ctx;
  beforeEach(() => { ctx = loadApp(); });

  it('addPage: undo entfernt neue Seite, redo stellt dieselbe id wieder her', () => {
    freshBook(ctx, [{ strokes: [{ id: 's1' }] }]);
    const before = pageIds(ctx);
    ctx.addPage();
    const afterAdd = pageIds(ctx);
    assert.equal(afterAdd.length, 2);
    const newId = ctx.split.panes[0].pageId;
    assert.ok(afterAdd.includes(newId));
    assert.notEqual(newId, before[0]);
    ctx.undo();
    assert.deepEqual(pageIds(ctx), before);
    assert.equal(ctx.split.panes[0].pageId, before[0]);
    assert.deepEqual(ctx.openBook().pages[0].strokes, [{ id: 's1' }]);
    ctx.redo();
    assert.deepEqual(pageIds(ctx), afterAdd);
    assert.equal(ctx.split.panes[0].pageId, newId);
  });

  it('deletePage: undo stellt Inhalt und Auswahl wieder her, redo löscht erneut', () => {
    const b = freshBook(ctx, [
      { strokes: [{ id: 'a' }] },
      { texts: [{ id: 't', html: 'B' }], bg: 'blob:x' },
      {},
    ]);
    const victim = JSON.parse(JSON.stringify(b.pages[1]));
    openPage(ctx, 'p2');
    ctx.deletePage();
    assert.deepEqual(pageIds(ctx), ['p1', 'p3']);
    assert.equal(ctx.split.panes[0].pageId, 'p1');
    ctx.undo();
    assert.deepEqual(pageIds(ctx), ['p1', 'p2', 'p3']);
    assert.equal(ctx.split.panes[0].pageId, 'p2');
    assert.deepEqual(ctx.openBook().pages[1], victim);
    ctx.redo();
    assert.deepEqual(pageIds(ctx), ['p1', 'p3']);
    assert.equal(ctx.split.panes[0].pageId, 'p1');
  });

  it('duplicatePage: undo/redo erhält übrige Seiten und Kopie-id', () => {
    freshBook(ctx, [{ strokes: [{ id: 'a' }] }, { texts: [{ id: 't' }] }]);
    openPage(ctx, 'p2');
    ctx.duplicatePage();
    let ids = pageIds(ctx);
    assert.equal(ids.length, 3);
    const copyId = ctx.split.panes[0].pageId;
    assert.notEqual(copyId, 'p2');
    const copy = JSON.parse(JSON.stringify(ctx.openBook().pages[2]));
    ctx.undo();
    assert.deepEqual(pageIds(ctx), ['p1', 'p2']);
    assert.equal(ctx.split.panes[0].pageId, 'p2');
    ctx.redo();
    ids = pageIds(ctx);
    assert.equal(ids.length, 3);
    assert.equal(ctx.split.panes[0].pageId, copyId);
    assert.deepEqual(ctx.openBook().pages[2], copy);
  });

  it('verschachtelt: Zeichnung + addPage undo in der richtigen Reihenfolge', () => {
    freshBook(ctx, [{}]);
    ctx.snapshot();
    ctx.openBook().pages[0].strokes.push({ id: 's1' });
    ctx.addPage();
    assert.equal(pageIds(ctx).length, 2);
    ctx.undo();
    assert.deepEqual(pageIds(ctx), ['p1']);
    assert.deepEqual(ctx.openBook().pages[0].strokes, [{ id: 's1' }]);
    ctx.undo();
    assert.deepEqual(ctx.openBook().pages[0].strokes, []);
    ctx.redo();
    assert.deepEqual(ctx.openBook().pages[0].strokes, [{ id: 's1' }]);
    ctx.redo();
    assert.equal(pageIds(ctx).length, 2);
    assert.deepEqual(ctx.openBook().pages[0].strokes, [{ id: 's1' }]);
  });

  it('bg überlebt undo/redo der Seite', () => {
    freshBook(ctx, [{ bg: 'blob:alt' }]);
    ctx.snapshot();
    ctx.openBook().pages[0].bg = 'blob:neu';
    ctx.undo();
    assert.equal(ctx.openBook().pages[0].bg, 'blob:alt');
    ctx.redo();
    assert.equal(ctx.openBook().pages[0].bg, 'blob:neu');
  });
});

describe('app/drag element bleibt angehängt', () => {
  let ctx;
  beforeEach(() => { ctx = loadApp(); });

  function pointerDown(el, obj, kind, tool, x, y) {
    ctx.tool = tool;
    ctx._renderTextCalls = 0;
    ctx._renderImgCalls = 0;
    ctx.makeDraggable(el, obj, kind);
    const ev = {
      preventDefault: () => {},
      stopPropagation: () => {},
      target: { classList: { contains: () => false } },
      currentTarget: el,
      clientX: x,
      clientY: y,
    };
    el.onpointerdown(ev);
    return ev;
  }

  function lastListener(type) {
    const l = ctx._windowStub._listeners[type] || [];
    return l[l.length - 1];
  }

  it('text-drag: kein Layer-Neuaufbau, exklusive Auswahl, sichtbare Bewegung', () => {
    freshBook(ctx, [{}]);
    const el = makeEl();
    const obj = { id: 't1', x: 0.2, y: 0.3 };
    pointerDown(el, obj, 'text', 'move', 50, 60);
    assert.equal(ctx._renderTextCalls, 0);
    assert.equal(ctx._renderImgCalls, 0);
    assert.equal(ctx.selectedBox, 't1');
    assert.equal(ctx.selectedImg, null);
    assert.equal(el.classList.contains('selected'), true);
    lastListener('pointermove')({ clientX: 70, clientY: 80 });
    assert.ok(Math.abs(obj.x - 0.3) < 1e-9);
    assert.ok(Math.abs(obj.y - 0.4) < 1e-9);
    assert.equal(el.style.left, obj.x * 100 + '%');
    assert.equal(el.style.top, obj.y * 100 + '%');
    lastListener('pointerup')();
    assert.deepEqual(ctx._windowStub._listeners['pointermove'] || [], []);
  });

  it('img-drag: pointercancel räumt auf, bild bleibt gewählt', () => {
    freshBook(ctx, [{}]);
    const el = makeEl();
    const obj = { id: 'i1', x: 0.1, y: 0.1 };
    pointerDown(el, obj, 'img', 'move', 10, 10);
    assert.equal(ctx.selectedImg, 'i1');
    assert.equal(ctx.selectedBox, null);
    lastListener('pointermove')({ clientX: 30, clientY: 10 });
    assert.ok(obj.x > 0.1);
    lastListener('pointercancel')();
    assert.deepEqual(ctx._windowStub._listeners['pointermove'] || [], []);
    assert.deepEqual(ctx._windowStub._listeners['pointerup'] || [], []);
  });

  it('startResize registriert pointercancel und skaliert', () => {
    freshBook(ctx, [{}]);
    const im = { id: 'i1', w: 0.5 };
    ctx.startResize({ clientX: 10 }, im);
    const types = Object.keys(ctx._windowStub._listeners);
    assert.ok(types.includes('pointercancel'));
    lastListener('pointermove')({ clientX: 30 });
    assert.ok(im.w > 0.5);
    assert.ok(ctx._renderImgCalls > 0);
    lastListener('pointercancel')();
    assert.deepEqual(ctx._windowStub._listeners['pointermove'] || [], []);
  });
});
