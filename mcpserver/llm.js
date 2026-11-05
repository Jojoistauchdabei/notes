'use strict';
/* Federwerk: LLM-Adapter (OpenAI-kompatibel) fuer DeepSeek und andere Provider.

DeepSeek exposed eine OpenAI-kompatible Chat-Completions-API, deshalb
laeuft der Adapter ueber /v1/chat/completions. Damit ist die Lernschicht
spaeter austauschbar (DeepSeek <-> andere OpenAI-kompatible Endpunkte).

Der Adapter ist bewusst ohne Dependencies und testbar: fetch ist injizierbar,
baseUrl/apiKey/model sind injizierbar bzw. ueber Env konfigurierbar.
*/

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

function createLlm(opts) {
  opts = opts || {};
  const baseUrl = String(opts.baseUrl || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = opts.apiKey || process.env.DEEPSEEK_API_KEY || '';
  const model = String(opts.model || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL);
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchImpl) {
    const e = new Error('LLM-Adapter: kein fetch verfuegbar');
    e.status = 500;
    throw e;
  }

  async function ask(messages, askOpts) {
    askOpts = askOpts || {};
    const body = {
      model: model,
      messages: (Array.isArray(messages) ? messages : []).map(function (m) {
        return { role: (m && m.role) ? String(m.role) : 'user', content: String((m && m.content) || '') };
      }),
      temperature: typeof askOpts.temperature === 'number' ? askOpts.temperature : 0.2,
      max_tokens: typeof askOpts.maxTokens === 'number' ? askOpts.maxTokens : 2000,
    };
    const r = await fetchImpl(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) {
      const msg = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + r.status);
      const e = new Error('LLM-Anfrage fehlgeschlagen: ' + msg);
      e.status = r.status;
      throw e;
    }
    const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const usage = (data && data.usage) || null;
    return { content: String(content || ''), model: model, usage: usage };
  }

  return { baseUrl: baseUrl, model: model, ask: ask };
}

/* LLM-Antwort -> Karten. Modelle liefern je nach Prompt ein nacktes Array,
 * ein {cards:[...]}-Objekt oder Fliesstext mit JSON/Fenced-Block. */
function parseCards(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const candidates = [];
  if (raw[0] === '[' || raw[0] === '{') candidates.push(raw);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const openObj = raw.indexOf('{');
  const closeObj = raw.lastIndexOf('}');
  if (openObj >= 0 && closeObj > openObj) candidates.push(raw.slice(openObj, closeObj + 1));
  const openArr = raw.indexOf('[');
  const closeArr = raw.lastIndexOf(']');
  if (openArr >= 0 && closeArr > openArr) candidates.push(raw.slice(openArr, closeArr + 1));

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (e) {
      continue;
    }
    const arr = Array.isArray(parsed) ? parsed : (parsed && (parsed.cards || parsed.flashcards));
    if (!Array.isArray(arr)) continue;
    const out = [];
    for (const c of arr) {
      if (!c || typeof c !== 'object') continue;
      const front = String(c.front || c.frontText || c.question || '').trim();
      const back = String(c.back || c.backText || c.answer || '').trim();
      if (!front && !back) continue;
      out.push({ front: front, back: back });
    }
    if (out.length) return out;
  }
  return [];
}

module.exports = {
  createLlm: createLlm,
  parseCards: parseCards,
  DEFAULT_BASE_URL: DEFAULT_BASE_URL,
  DEFAULT_MODEL: DEFAULT_MODEL,
};
