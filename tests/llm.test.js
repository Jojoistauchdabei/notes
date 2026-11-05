'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLlm, parseCards, DEFAULT_BASE_URL, DEFAULT_MODEL } = require('../mcpserver/llm');

describe('mcpserver llm', () => {
  it('exposes default deepseek base url and model', () => {
    assert.equal(DEFAULT_BASE_URL, 'https://api.deepseek.com/v1');
    assert.equal(DEFAULT_MODEL, 'deepseek-chat');
  });

  it('asks via openai-compatible chat completions', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url: String(url), opts: opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Die Antwort' } }], usage: { total_tokens: 5 } }),
      };
    };
    const llm = createLlm({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-chat', fetchImpl: fetchImpl });
    const res = await llm.ask([{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }], { temperature: 0.2, maxTokens: 100 });
    assert.equal(res.content, 'Die Antwort');
    assert.equal(res.model, 'deepseek-chat');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.messages[0].role, 'system');
  });

  it('throws on llm error', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) });
    const llm = createLlm({ fetchImpl: fetchImpl });
    await assert.rejects(() => llm.ask([{ role: 'user', content: 'q' }]), /LLM-Anfrage fehlgeschlagen/);
  });
});

describe('mcpserver llm: parseCards', () => {
  it('liest ein nacktes JSON-Array', () => {
    assert.deepEqual(parseCards('[{"front":"F","back":"A"}]'), [{ front: 'F', back: 'A' }]);
  });

  it('liest ein {cards:[...]}-Objekt', () => {
    assert.deepEqual(parseCards('{"cards":[{"question":"F?","answer":"A"}]}'), [{ front: 'F?', back: 'A' }]);
  });

  it('liest JSON aus Fliesstext und Codefences', () => {
    assert.deepEqual(
      parseCards('Hier die Karten:\n```json\n[{"front":"F","back":"A"}]\n```\nViel Erfolg!'),
      [{ front: 'F', back: 'A' }],
    );
  });

  it('liefert bei Muell oder leeren Karten []', () => {
    assert.deepEqual(parseCards('kein json'), []);
    assert.deepEqual(parseCards('[{"front":"","back":""}]'), []);
    assert.deepEqual(parseCards(''), []);
  });
});
