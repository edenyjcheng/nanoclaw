/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Auth priority:
 *   1. OAuth (Claude Pro subscription) — primary when credentials file exists
 *   2. ANTHROPIC_API_KEY              — fallback when OAuth returns 429
 *   3. Ollama fallback mode           — host-level, when both are exhausted
 *                                       (handled in index.ts via credentialEvents)
 *
 * Fallback is transparent to containers; only applies to /v1/* inference calls.
 */
import { EventEmitter } from 'events';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, IncomingMessage, RequestOptions } from 'http';
import { ServerResponse } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Emits 'exhausted' when all credentials return 429 (rate-limited).
 * Emits 'recovered' when a request succeeds after exhaustion.
 * Consumed by index.ts to switch to Ollama fallback mode.
 */
export const credentialEvents = new EventEmitter();
let credentialsExhausted = false;

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

function markExhausted(): void {
  if (!credentialsExhausted) {
    credentialsExhausted = true;
    credentialEvents.emit('exhausted');
  }
}

function markRecovered(): void {
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

  // Forward a request to upstream with the given headers.
  // On 429 + canFallback: retries once with ANTHROPIC_API_KEY.
  function forwardRequest(
    method: string,
    url: string,
    headers: Record<string, string | number | string[] | undefined>,
    body: Buffer,
    clientRes: ServerResponse,
    canFallback: boolean,
  ): void {
    const upstream = makeRequest(
      { ...upstreamOpts, path: url, method, headers } as RequestOptions,
      (upRes: IncomingMessage) => {
        if (
          upRes.statusCode === 429 &&
          canFallback &&
          secrets.ANTHROPIC_API_KEY
        ) {
          // OAuth rate-limited — drain response and retry with API key
          upRes.resume();
          logger.warn(
            { url },
            'OAuth rate-limited, retrying with ANTHROPIC_API_KEY',
          );

          const fallbackHeaders = { ...headers };
          delete fallbackHeaders['authorization'];
          delete fallbackHeaders['x-api-key'];
          fallbackHeaders['x-api-key'] = secrets.ANTHROPIC_API_KEY;

          const retry = makeRequest(
            {
              ...upstreamOpts,
              path: url,
              method,
              headers: fallbackHeaders,
            } as RequestOptions,
            (retryRes: IncomingMessage) => {
              if (retryRes.statusCode === 429) {
                logger.error(
                  { url },
                  'Both OAuth and API key rate-limited — switching to Ollama fallback',
                );
                markExhausted();
              } else {
                markRecovered();
              }
              clientRes.writeHead(retryRes.statusCode!, retryRes.headers);
              retryRes.pipe(clientRes);
            },
          );
          retry.on('error', (err) => {
            logger.error({ err, url }, 'API key fallback request error');
            if (!clientRes.headersSent) {
              clientRes.writeHead(502);
              clientRes.end('Bad Gateway');
            }
          });
          retry.write(body);
          retry.end();
        } else {
          if (upRes.statusCode === 429) {
            // No fallback available — this credential is the only one
            logger.error(
              { url },
              'API rate-limited and no fallback available — switching to Ollama fallback',
            );
            markExhausted();
          } else {
            markRecovered();
          }
          clientRes.writeHead(upRes.statusCode!, upRes.headers);
          upRes.pipe(clientRes);
        }
      },
    );
    upstream.on('error', (err) => {
      logger.error({ err, url }, 'Credential proxy upstream error');
      if (!clientRes.headersSent) {
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
