'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mcpFunction = require('../mcp/index');

describe('mcp/appwrite-function', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.APPWRITE_API_KEY = 'test-key';
    process.env.APPWRITE_USER_ID = 'user-123';
    process.env.MCP_TOKEN = 'secret-token';
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  function createMockRes() {
    return {
      status: null,
      headers: {},
      body: null,
      json(data, status = 200, headers = {}) {
        this.status = status;
        this.headers = headers;
        this.body = data;
        return this;
      },
      text(str, status = 200, headers = {}) {
        this.status = status;
        this.headers = headers;
        this.body = str;
        return this;
      },
      empty() {
        this.status = 204;
        return this;
      },
    };
  }

  it('beantwortet GET mit Service-Info', async () => {
    const res = createMockRes();
    await mcpFunction({
      req: { method: 'GET' },
      res,
      error: () => {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.service, 'federwerk-mcp');
  });

  it('beantwortet OPTIONS mit CORS-Headern', async () => {
    const res = createMockRes();
    await mcpFunction({
      req: { method: 'OPTIONS' },
      res,
      error: () => {},
    });
    assert.equal(res.status, 204);
    assert.ok(res.headers['Access-Control-Allow-Origin']);
  });

  it('lehnt unautorisierte Anfragen bei gesetztem MCP_TOKEN ab', async () => {
    const res = createMockRes();
    await mcpFunction({
      req: {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-token' },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      },
      res,
      error: () => {},
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, -32001);
    assert.equal(res.body.error.message, 'Unauthorized');
  });

  it('erfordert APPWRITE_API_KEY und APPWRITE_USER_ID', async () => {
    delete process.env.APPWRITE_API_KEY;
    const res = createMockRes();
    await mcpFunction({
      req: {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token' },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      },
      res,
      error: () => {},
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, -32000);
    assert.match(res.body.error.message, /APPWRITE_API_KEY/);
  });

  it('parst Body im String- oder JSON-Format', () => {
    assert.deepEqual(mcpFunction.parseBody({ bodyJson: { a: 1 } }), { a: 1 });
    assert.deepEqual(mcpFunction.parseBody({ bodyText: '{"b":2}' }), { b: 2 });
    assert.deepEqual(mcpFunction.parseBody({ body: '{"c":3}' }), { c: 3 });
    assert.deepEqual(mcpFunction.parseBody({ body: { d: 4 } }), { d: 4 });
  });

  it('extrahiert Bearer- und X-MCP-Token case-insensitiv', () => {
    assert.equal(mcpFunction.authValue({ authorization: 'Bearer abc' }), 'abc');
    assert.equal(mcpFunction.authValue({ Authorization: 'Bearer def' }), 'def');
    assert.equal(mcpFunction.authValue({ 'x-mcp-token': 'ghi' }), 'ghi');
    assert.equal(mcpFunction.authValue({ 'X-MCP-Token': 'jkl' }), 'jkl');
  });
});
