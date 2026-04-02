import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// vi.mock is hoisted above variable declarations, so mockEnv must be declared
// with vi.hoisted to be accessible inside the factory.
const mockEnv = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  startCredentialProxy,
  setForcedAuthMode,
  credentialEvents,
  RECOVERY_BACKOFF_MS,
  resetRecoveryState,
} from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    resetRecoveryState();
    setForcedAuthMode(null);
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
    // Force api-key mode: readClaudeCliToken() may find a real credentials file on
    // the host and auto-detect oauth, so we override explicitly.
    setForcedAuthMode('api-key');

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    // The proxy replaces the placeholder with the live token. On machines with a
    // real ~/.claude/.credentials.json the live token differs from the mock env
    // value, so we just verify the placeholder was replaced with a real token.
    expect(lastUpstreamHeaders['authorization']).toMatch(/^Bearer /);
    expect(lastUpstreamHeaders['authorization']).not.toBe('Bearer placeholder');
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });
});

// ---------------------------------------------------------------------------
// SSE token-usage tap
// ---------------------------------------------------------------------------
describe('credential-proxy SSE usage tap', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;

  // Craft a minimal Anthropic SSE response with known token counts
  const SSE_BODY = [
    'data: {"type":"message_start","message":{"id":"msg_test","usage":{"input_tokens":42,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
    '',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":7}}',
    '',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  beforeEach(async () => {
    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'transfer-encoding': 'chunked',
      });
      res.end(SSE_BODY);
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;
    mockEnv['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${upstreamPort}`;
    mockEnv['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    resetRecoveryState();
    setForcedAuthMode(null);
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  it('emits usage event with correct input + output tokens from SSE response', async () => {
    setForcedAuthMode('api-key');

    const usagePromise = new Promise<{
      inputTokens: number;
      outputTokens: number;
      total: number;
    }>((resolve) => {
      credentialEvents.once('usage', resolve);
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);

    const usage = await usagePromise;
    expect(usage.inputTokens).toBe(42);
    expect(usage.outputTokens).toBe(7);
    expect(usage.total).toBe(49);
  });

  it('body passes through unchanged to client', async () => {
    setForcedAuthMode('api-key');

    // Consume the usage event so it doesn't leak between tests
    credentialEvents.once('usage', () => {});

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SSE_BODY);
  });

  it('does not emit usage event for non-SSE responses (no token events)', async () => {
    // Swap upstream to return plain JSON (no SSE events)
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    const plainServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg_plain"}');
    });
    await new Promise<void>((resolve) =>
      plainServer.listen(0, '127.0.0.1', resolve),
    );
    const plainPort = (plainServer.address() as AddressInfo).port;
    mockEnv['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${plainPort}`;

    await new Promise<void>((r) => proxyServer.close(() => r()));
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;
    setForcedAuthMode('api-key');

    let usageFired = false;
    credentialEvents.once('usage', () => {
      usageFired = true;
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    // Give the flush callback a tick to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(usageFired).toBe(false);

    await new Promise<void>((r) => plainServer.close(() => r()));
  });
});

// ---------------------------------------------------------------------------
// Auth mode switching and Ollama fallback trigger
// ---------------------------------------------------------------------------
describe('credential-proxy auth mode switching', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let capturedRequests: Array<http.IncomingHttpHeaders>;
  // Callable so individual tests can control per-request responses
  let upstreamStatusFn: () => number;

  beforeEach(async () => {
    capturedRequests = [];
    upstreamStatusFn = () => 200;

    upstreamServer = http.createServer((req, res) => {
      capturedRequests.push({ ...req.headers });
      const status = upstreamStatusFn();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;
    mockEnv['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${upstreamPort}`;
  });

  afterEach(async () => {
    resetRecoveryState();
    setForcedAuthMode(null);
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env);
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  // --- Individual credential checks ---

  it('OAuth only: placeholder Authorization is replaced before reaching upstream', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    // Placeholder must be replaced with a real token (live file token or env token).
    expect(capturedRequests[0]['authorization']).toMatch(/^Bearer /);
    expect(capturedRequests[0]['authorization']).not.toBe('Bearer placeholder');
  });

  it('API key only: real key is injected, placeholder never reaches upstream', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
    // Force api-key mode — readClaudeCliToken() may auto-detect oauth on this host.
    setForcedAuthMode('api-key');

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(capturedRequests[0]['x-api-key']).toBe('sk-ant-real-key');
  });

  it('Ollama mode (no credentials): proxy passes through without injecting auth', async () => {
    // No ANTHROPIC_API_KEY or OAuth token — simulates pure Ollama config
    proxyPort = await startProxy({});

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    // Proxy should still forward the request; upstream (here a stub) replies 200
    expect(res.statusCode).toBe(200);
    expect(capturedRequests[0]['x-api-key']).toBeUndefined();
    expect(capturedRequests[0]['authorization']).toBeUndefined();
  });

  // --- Combined / switching scenarios ---

  it('forced api-key mode: strips stale OAuth Authorization header from container', async () => {
    // Both credentials present, but forced to api-key (e.g. after set_llm_mode api-key)
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
    });
    setForcedAuthMode('api-key');

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
          // Container has a cached OAuth token in .credentials.json from a previous OAuth session
          authorization: 'Bearer stale-cached-oauth-token',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    // Real API key injected, stale OAuth header stripped
    expect(capturedRequests[0]['x-api-key']).toBe('sk-ant-real-key');
    expect(capturedRequests[0]['authorization']).toBeUndefined();
  });

  it('OAuth 429 → API-key fallback: retries with real key, upstream sees two requests', async () => {
    let callCount = 0;
    upstreamStatusFn = () => (++callCount === 1 ? 429 : 200);

    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
      ANTHROPIC_API_KEY: 'sk-ant-fallback',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    // First attempt (OAuth) + retry (API key)
    expect(capturedRequests).toHaveLength(2);
    // Retry carries x-api-key, not Authorization
    expect(capturedRequests[1]['x-api-key']).toBe('sk-ant-fallback');
    expect(capturedRequests[1]['authorization']).toBeUndefined();
  });

  it('both credentials 429 → exhausted event fires (triggers Ollama fallback in index.ts)', async () => {
    upstreamStatusFn = () => 429;

    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
      ANTHROPIC_API_KEY: 'sk-ant-key',
    });

    // Guarantee we start from a recovered state so the event fires exactly once
    credentialEvents.emit('recovered');

    const exhaustedFired = new Promise<void>((resolve) => {
      credentialEvents.once('exhausted', resolve);
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    // Both OAuth (429) and API key (429) exhausted → event must have fired by now
    await exhaustedFired;
    // Upstream received exactly two requests: initial OAuth + API key retry
    expect(capturedRequests).toHaveLength(2);
  });

  it('auto-recovery timer fires after backoff delay and emits recovered', async () => {
    // Inject a short delay so the test doesn't take a minute.
    // Mutate the exported array — the module reads it at call time.
    const origBackoff = RECOVERY_BACKOFF_MS.splice(0);
    RECOVERY_BACKOFF_MS.push(80, 160, 320, 640);

    upstreamStatusFn = () => 429;
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
      ANTHROPIC_API_KEY: 'sk-ant-key',
    });

    credentialEvents.emit('recovered'); // ensure clean state

    const exhausted = new Promise<void>((r) =>
      credentialEvents.once('exhausted', r),
    );
    const recovered = new Promise<void>((r) =>
      credentialEvents.once('recovered', r),
    );

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    await exhausted;
    await recovered; // real timer fires after 80 ms — no extra API call

    // No extra upstream requests — recovery was free
    expect(capturedRequests).toHaveLength(2);

    RECOVERY_BACKOFF_MS.splice(0, RECOVERY_BACKOFF_MS.length, ...origBackoff);
  }, 3000);

  it('real success after exhaustion cancels the backoff timer', async () => {
    const origBackoff = RECOVERY_BACKOFF_MS.splice(0);
    RECOVERY_BACKOFF_MS.push(5000, 10000, 20000, 40000); // long enough to not fire during test

    upstreamStatusFn = () => 429;
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
      ANTHROPIC_API_KEY: 'sk-ant-key',
    });

    credentialEvents.emit('recovered');

    const exhausted = new Promise<void>((r) =>
      credentialEvents.once('exhausted', r),
    );
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );
    await exhausted;

    // Real successful request arrives before the timer fires — should cancel it
    upstreamStatusFn = () => 200;
    const recovered = new Promise<void>((r) =>
      credentialEvents.once('recovered', r),
    );
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );
    await recovered; // markRecovered() from real success

    // Timer was cancelled — no spurious second 'recovered' event after waiting
    let spurious = false;
    credentialEvents.once('recovered', () => {
      spurious = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(spurious).toBe(false);

    RECOVERY_BACKOFF_MS.splice(0, RECOVERY_BACKOFF_MS.length, ...origBackoff);
  }, 3000);
});
