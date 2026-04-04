/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Auth priority chain:
 *   1. OAuth  + Sonnet   — primary
 *   2. API key + Sonnet  — when OAuth quota exhausted
 *   3. Ollama            — host-level last resort (handled in index.ts via credentialEvents)
 *
 * Fallback is transparent to containers; only applies to /v1/* inference calls.
 * Full-exhaustion state is persisted to disk so restarts don't blindly retry
 * credentials known to be quota-blocked.
 */
import { EventEmitter } from 'events';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, IncomingMessage, RequestOptions } from 'http';
import { ServerResponse } from 'http';
import { Transform } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const EXHAUSTION_STATE_FILE = path.join(DATA_DIR, 'credential-exhaustion.json');

function persistExhaustedState(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      EXHAUSTION_STATE_FILE,
      JSON.stringify({ exhaustedAt: Date.now() }),
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to persist credential exhaustion state');
  }
}

function clearPersistedExhaustedState(): void {
  try {
    fs.unlinkSync(EXHAUSTION_STATE_FILE);
  } catch {
    /* ignore */
  }
}

/**
 * Emits 'exhausted' when all credentials are exhausted — switches to Ollama.
 * Emits 'recovered' when a request succeeds after exhaustion, or when the
 * auto-recovery timer fires after the rate-limit window expires.
 * Consumed by index.ts to notify the user and manage fallback modes.
 */
export const credentialEvents = new EventEmitter();
let credentialsExhausted = false;

/**
 * Auto-recovery timer: fires after the rate-limit window and resets exhaustion
 * so the next real user message retries Claude instead of staying in Ollama mode.
 * Uses exponential backoff — no synthetic API calls, zero extra cost.
 * Backoff schedule (minutes): 1 → 5 → 15 → 30 (capped).
 * When the API returns a hard quota reset timestamp, that exact time is used instead.
 */
export const RECOVERY_BACKOFF_MS = [1, 5, 15, 30].map((m) => m * 60 * 1000);
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryAttempt = 0;

/**
 * Parse a hard-quota reset timestamp from Anthropic error bodies like:
 * "You will regain access on 2026-04-01 at 00:00 UTC."
 * Returns the Date if found and in the future, otherwise undefined.
 */
function parseResetDate(body: string): Date | undefined {
  const m = body.match(
    /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) UTC/,
  );
  if (!m) return undefined;
  const d = new Date(`${m[1]}T${m[2]}:00Z`);
  return isNaN(d.getTime()) || d.getTime() <= Date.now() ? undefined : d;
}

function scheduleRecovery(resetAt?: Date): void {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  let delay: number;
  if (resetAt) {
    // Hard quota with known reset time — wait until then, plus a small buffer.
    delay = Math.max(resetAt.getTime() - Date.now() + 5_000, 0);
    logger.info(
      { resetAt: resetAt.toISOString(), delayMs: delay },
      'Hard quota limit — scheduling recovery at known reset time',
    );
  } else {
    delay =
      RECOVERY_BACKOFF_MS[
        Math.min(recoveryAttempt, RECOVERY_BACKOFF_MS.length - 1)
      ];
    recoveryAttempt++;
    logger.info(
      { attempt: recoveryAttempt, delayMs: delay },
      'Scheduling auto-recovery probe — will retry Claude on next message',
    );
  }
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    logger.info('Auto-recovery window elapsed — resetting exhaustion flag');
    // Reset without a real API call. The next organic request will verify.
    credentialsExhausted = false;
    clearPersistedExhaustedState();
    credentialEvents.emit('recovered');
  }, delay);
}

/**
 * Override the auth mode for all subsequent requests and new containers.
 * null = auto (default: prefer OAuth, fall back to API key).
 * Set by Cortana via the set_llm_mode IPC command.
 */
let forcedAuthMode: AuthMode | null = null;

export function setForcedAuthMode(mode: AuthMode | null): void {
  forcedAuthMode = mode;
  logger.info({ mode: mode ?? 'auto' }, 'LLM auth mode set');
}

/** Reset all recovery state. Clears in-memory flags, the backoff timer, and the persisted exhaustion file. */
export function resetRecoveryState(): void {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  recoveryAttempt = 0;
  credentialsExhausted = false;
  clearPersistedExhaustedState();
}

function markExhausted(resetAt?: Date): void {
  if (!credentialsExhausted) {
    credentialsExhausted = true;
    persistExhaustedState();
    credentialEvents.emit('exhausted');
    scheduleRecovery(resetAt);
  }
}

function markRecovered(): void {
  // Called when a real request succeeds — cancel the timer and reset backoff.
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  recoveryAttempt = 0;
  clearPersistedExhaustedState();
  if (credentialsExhausted) {
    credentialsExhausted = false;
    credentialEvents.emit('recovered');
  }
}

/**
 * Read the current OAuth access token from ~/.claude/.credentials.json.
 * Claude Code CLI keeps this file up-to-date with fresh tokens automatically.
 * Returns undefined if the file is missing or unparseable.
 */
function readClaudeCliToken(): string | undefined {
  try {
    const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
    const raw = fs.readFileSync(credFile, 'utf-8');
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken as string | undefined;
  } catch {
    return undefined;
  }
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/**
 * Pipe an Anthropic SSE response to the client while tapping usage data.
 * Parses `message_start` (input tokens) and `message_delta` (output tokens)
 * events from the stream and emits 'usage' on credentialEvents at end.
 * Data passes through unchanged with no added latency.
 */
function pipeThroughSseTap(
  source: IncomingMessage,
  dest: ServerResponse,
): void {
  let partial = '';
  let inputTokens = 0;
  let outputTokens = 0;

  function parseSseLine(line: string): void {
    if (!line.startsWith('data: ')) return;
    try {
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'message_start' && ev.message?.usage) {
        inputTokens += ev.message.usage.input_tokens ?? 0;
      } else if (ev.type === 'message_delta' && ev.usage) {
        outputTokens += ev.usage.output_tokens ?? 0;
      }
    } catch {
      /* non-JSON SSE line (e.g. [DONE]) */
    }
  }

  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      partial += chunk.toString('utf8');
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) parseSseLine(line);
      cb(null, chunk);
    },
    flush(cb) {
      parseSseLine(partial);
      const total = inputTokens + outputTokens;
      if (total > 0) {
        credentialEvents.emit('usage', { inputTokens, outputTokens, total });
      }
      cb();
    },
  });

  source.pipe(tap).pipe(dest);
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  // Static fallback from .env — used only when the credentials file is absent.
  const envOauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  // Resolve the live token on each request so we always use the latest value
  // from ~/.claude/.credentials.json (kept fresh by Claude Code CLI).
  const getLiveToken = (): string | undefined =>
    readClaudeCliToken() ?? envOauthToken;

  // Prefer OAuth as primary (free within Pro subscription).
  // API key is fallback only, even when both are present.
  const authMode: AuthMode = getLiveToken()
    ? 'oauth'
    : secrets.ANTHROPIC_API_KEY
      ? 'api-key'
      : 'oauth';

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;
  const upstreamOpts = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (isHttps ? 443 : 80),
  };

  // Returns true when a response indicates quota/rate-limit exhaustion.
  // Handles Anthropic's non-standard 400 "usage limits" response in addition to 429.
  function isQuotaExhausted(statusCode: number, body?: string): boolean {
    if (statusCode === 429) return true;
    if (statusCode === 400 && body?.includes('API usage limits')) return true;
    if (statusCode === 400 && body?.includes('usage limit')) return true;
    return false;
  }

  // Forward a request to upstream with the given headers.
  // Auth fallback chain on quota exhaustion:
  //   1. Primary (Sonnet via OAuth)
  //   2. API key + Sonnet — when OAuth quota exhausted
  //   3. markExhausted()  — Ollama mode (handled in index.ts)
  // Also retries with API key on 401 auth errors.
  function forwardRequest(
    method: string,
    url: string,
    headers: Record<string, string | number | string[] | undefined>,
    body: Buffer,
    clientRes: ServerResponse,
    canFallback: boolean,
  ): void {
    // Tier 2: retry with ANTHROPIC_API_KEY using the same body (same Sonnet model).
    function doApiKeyFallback(fallbackBody: Buffer): void {
      const fallbackHeaders = { ...headers };
      delete fallbackHeaders['authorization'];
      delete fallbackHeaders['x-api-key'];
      fallbackHeaders['x-api-key'] = secrets.ANTHROPIC_API_KEY;
      fallbackHeaders['content-length'] = fallbackBody.length;

      const retry = makeRequest(
        {
          ...upstreamOpts,
          path: url,
          method,
          headers: fallbackHeaders,
        } as RequestOptions,
        (retryRes: IncomingMessage) => {
          if (
            retryRes.statusCode === 400 ||
            retryRes.statusCode === 429 ||
            retryRes.statusCode === 401
          ) {
            const retryChunks: Buffer[] = [];
            retryRes.on('data', (c: Buffer) => retryChunks.push(c));
            retryRes.on('end', () => {
              const retryBodyText = Buffer.concat(retryChunks).toString('utf8');
              if (
                isQuotaExhausted(retryRes.statusCode!, retryBodyText) ||
                retryRes.statusCode === 401
              ) {
                logger.error(
                  { url, status: retryRes.statusCode },
                  'API key also exhausted — switching to Ollama fallback',
                );
                markExhausted(parseResetDate(retryBodyText));
              } else {
                logger.warn(
                  {
                    url,
                    status: retryRes.statusCode,
                    body: retryBodyText.slice(0, 200),
                  },
                  'API key returned non-quota error — forwarding without state change',
                );
              }
              clientRes.writeHead(retryRes.statusCode!, retryRes.headers);
              clientRes.end(Buffer.concat(retryChunks));
            });
          } else {
            logger.info(
              { url, status: retryRes.statusCode },
              'API key fallback succeeded',
            );
            markRecovered();
            clientRes.writeHead(retryRes.statusCode!, retryRes.headers);
            pipeThroughSseTap(retryRes, clientRes);
          }
        },
      );
      retry.on('error', (err) => {
        logger.error({ err, url }, 'API key fallback request error');
        if (!clientRes.headersSent) {
          clientRes.writeHead(502);
          clientRes.end('Bad Gateway');
        }
      });
      retry.write(fallbackBody);
      retry.end();
    }

    const upstream = makeRequest(
      { ...upstreamOpts, path: url, method, headers } as RequestOptions,
      (upRes: IncomingMessage) => {
        if (
          upRes.statusCode === 401 &&
          canFallback &&
          secrets.ANTHROPIC_API_KEY
        ) {
          // Auth error — drain and retry with API key
          upRes.resume();
          logger.warn(
            { url, status: 401 },
            'OAuth auth error, retrying with API key',
          );
          doApiKeyFallback(body);
        } else if (upRes.statusCode === 401) {
          // Auth error with no API key to fall back to — escalate to Ollama
          upRes.resume();
          logger.error(
            { url },
            'OAuth auth error and no API key configured — switching to Ollama fallback',
          );
          markExhausted();
          if (!clientRes.headersSent) {
            clientRes.writeHead(503);
            clientRes.end('Service Unavailable');
          }
        } else if (upRes.statusCode === 400 || upRes.statusCode === 429) {
          // Buffer body to detect quota-exhaustion message.
          const upChunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => upChunks.push(c));
          upRes.on('end', () => {
            const upBodyText = Buffer.concat(upChunks).toString('utf8');
            if (isQuotaExhausted(upRes.statusCode!, upBodyText)) {
              // Quota hit — try API key next (same Sonnet model), then Ollama
              logger.warn(
                { url, status: upRes.statusCode },
                'OAuth quota exhausted, trying API key',
              );
              if (canFallback && secrets.ANTHROPIC_API_KEY) {
                doApiKeyFallback(body);
              } else {
                markExhausted(parseResetDate(upBodyText));
                clientRes.writeHead(upRes.statusCode!, upRes.headers);
                clientRes.end(Buffer.concat(upChunks));
              }
            } else {
              // 400/429 but not quota-related — pass through
              clientRes.writeHead(upRes.statusCode!, upRes.headers);
              clientRes.end(Buffer.concat(upChunks));
            }
          });
        } else if (
          upRes.statusCode! >= 500 &&
          canFallback &&
          secrets.ANTHROPIC_API_KEY
        ) {
          // Server error (502/503/etc.) — OAuth service may be down, try API key
          upRes.resume();
          logger.warn(
            { url, status: upRes.statusCode },
            'OAuth server error, retrying with API key',
          );
          doApiKeyFallback(body);
        } else if (upRes.statusCode! >= 500) {
          // Server error with no API key fallback — pass through
          upRes.resume();
          logger.error(
            { url, status: upRes.statusCode },
            'OAuth server error and no API key configured',
          );
          if (!clientRes.headersSent) {
            clientRes.writeHead(upRes.statusCode!);
            clientRes.end('Service Unavailable');
          }
        } else {
          // Success — stream to client, tapping usage data from SSE
          markRecovered();
          clientRes.writeHead(upRes.statusCode!, upRes.headers);
          pipeThroughSseTap(upRes, clientRes);
        }
      },
    );
    upstream.on('error', (err) => {
      logger.error({ err, url }, 'Credential proxy upstream error');
      if (canFallback && secrets.ANTHROPIC_API_KEY && !clientRes.headersSent) {
        logger.warn({ url }, 'OAuth connection failed, retrying with API key');
        doApiKeyFallback(body);
      } else if (!clientRes.headersSent) {
        clientRes.writeHead(502);
        clientRes.end('Bad Gateway');
      }
    });
    upstream.write(body);
    upstream.end();
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // Fallback only applies to inference calls, not token exchange endpoints
        const isInferenceCall = req.url?.startsWith('/v1/') ?? false;

        // Respect forced mode (set by Cortana via set_llm_mode command)
        const effectiveAuthMode = forcedAuthMode ?? authMode;

        if (effectiveAuthMode === 'api-key') {
          // API key mode: inject x-api-key on every request (no OAuth fallback available)
          // Also strip Authorization header in case the container has a cached OAuth token
          // in ~/.claude/.credentials.json — sending it alongside x-api-key causes 401.
          delete headers['authorization'];
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          forwardRequest(req.method!, req.url!, headers, body, res, false);
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            const token = getLiveToken();
            if (token) headers['authorization'] = `Bearer ${token}`;
          }
          // Allow API key fallback on inference calls when key is available and not force-overridden
          const canFallback =
            isInferenceCall && !!secrets.ANTHROPIC_API_KEY && !forcedAuthMode;
          forwardRequest(
            req.method!,
            req.url!,
            headers,
            body,
            res,
            canFallback,
          );
        }
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode, hasApiFallback: !!secrets.ANTHROPIC_API_KEY },
        'Credential proxy started',
      );
      // Restore exhaustion state persisted by a previous session (e.g. after a crash).
      // Emits event so index.ts activates Ollama fallback mode immediately on startup.
      if (fs.existsSync(EXHAUSTION_STATE_FILE)) {
        logger.warn(
          'Persisted full-exhaustion state found — restoring Ollama fallback mode',
        );
        markExhausted();
      }
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  // Respect manual override set by Cortana
  if (forcedAuthMode) return forcedAuthMode;
  // Prefer OAuth when credentials file exists (even if API key is also present)
  if (readClaudeCliToken()) return 'oauth';
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

/**
 * Append container env args that route API traffic through the credential proxy.
 * Call this from container-runner.ts instead of inline credential injection —
 * keeps all proxy logic in one file and reduces rebase conflict surface.
 */
export function applyCredentialProxyEnv(
  args: string[],
  hostGateway: string,
  proxyPort: number,
): void {
  args.push('-e', `ANTHROPIC_BASE_URL=http://${hostGateway}:${proxyPort}`);
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }
}
