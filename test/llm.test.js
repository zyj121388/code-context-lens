'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  streamChatCompletion,
  ApiError,
} = require('../out/llm/openAiCompatible.js');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/v1`,
      });
    });
  });
}

function baseOptions(url, overrides = {}) {
  return {
    baseUrl: url,
    model: 'mock-model',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.2,
    maxTokens: 100,
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('streams SSE deltas from an OpenAI-compatible endpoint', async () => {
  const { server, url } = await listen((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.stream, true);
      assert.equal(parsed.model, 'mock-model');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n');
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  try {
    const tokens = [];
    const result = await streamChatCompletion(
      baseOptions(url, {
        onToken: (token) => tokens.push(token),
      }),
    );
    assert.equal(result, '你好，世界');
    assert.deepEqual(tokens, ['你好', '，世界']);
  } finally {
    server.close();
  }
});

test('accepts a non-streaming JSON response from a compatible endpoint', async () => {
  const { server, url } = await listen((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });

  try {
    const result = await streamChatCompletion(baseOptions(url));
    assert.equal(result, 'OK');
  } finally {
    server.close();
  }
});

test('maps 401 responses to an actionable API error', async () => {
  const { server, url } = await listen((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'invalid key' } }));
    });
  });

  try {
    await assert.rejects(
      () => streamChatCompletion(baseOptions(url)),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 401);
        assert.match(error.message, /API Key/);
        assert.match(error.message, /invalid key/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});
