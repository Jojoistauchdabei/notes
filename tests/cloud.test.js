const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Cloud = require('../js/cloud.js');

describe('cloud/helpers', () => {
  it('joinUrl verbindet ohne Doppel-Slashes', () => {
    assert.equal(
      Cloud.joinUrl('https://cloud.de/remote.php/dav/files/u/', '/Grimoire/', 'a.json'),
      'https://cloud.de/remote.php/dav/files/u/Grimoire/a.json'
    );
  });
  it('normalizeBaseUrl trimmt Slashes', () => {
    assert.equal(Cloud.normalizeBaseUrl('https://cloud.de/  '), 'https://cloud.de');
    assert.equal(Cloud.normalizeBaseUrl('https://cloud.de///'), 'https://cloud.de');
  });
  it('bookFileName ist eindeutig + dateisystem-sicher', () => {
    const f = Cloud.bookFileName({ id: 'abc123', title: 'Mein Buch: D&D/Abenteuer!' });
    assert.match(f, /\.json$/);
    assert.match(f, /abc123/);
    assert.doesNotMatch(f, /[\/:]/);
  });
  it('parsePropfind findet nur .json, ignoriert Ordner selbst', () => {
    const xml = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/dav/files/u/Grimoire/</d:href></d:response>
        <d:response><d:href>/dav/files/u/Grimoire/Abenteuer__abc123.json</d:href></d:response>
        <d:response><d:href>/dav/files/u/Grimoire/Notizen.txt</d:href></d:response>
        <d:response><d:href>/dav/files/u/Grimoire/Zweites%20Buch__x9.json</d:href></d:response>
      </d:multistatus>`;
    const files = Cloud.parsePropfind(xml, 'https://cloud.de/dav/files/u/Grimoire');
    assert.deepEqual(files, ['Abenteuer__abc123.json', 'Zweites Buch__x9.json']);
  });
});
