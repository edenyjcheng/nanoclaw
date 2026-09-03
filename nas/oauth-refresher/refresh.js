/**
 * OAuth refresher — keeps the Anthropic credential in the OneCLI vault alive.
 *
 * Why this exists: OneCLI cannot refresh this credential. Its 60 OAuth apps
 * cover third-party services (Gmail, Notion, GitHub…) where OneCLI is the
 * registered client; there is no Anthropic app, and `secrets create/update`
 * accept only a literal --value. The vault therefore holds a static snapshot
 * that expires in ~24h (verified 2026-09-03). On BKK v1 the Claude Code CLI
 * refreshes continuously; nothing on the NAS does.
 *
 * Ported from v1 src/credential-proxy.ts:174-330 — same endpoint, same public
 * client id, same margins, all proven in production for months.
 *
 * Cost: none. A token refresh is an auth call, not inference. This is what
 * keeps the install on the OAuth subscription instead of needing an API key.
 *
 * ⚠️ EXACTLY ONE REFRESHER MAY RUN PER ACCOUNT. Anthropic rotates the refresh
 * token on every use, so if BKK v1 and this both run, each invalidates the
 * other and whichever refreshes second is left holding a dead credential —
 * breaking both assistants. BKK v1 owns this role until cutover, which is why
 * the compose service ships behind the "cutover" profile and does not start
 * by default.
 */

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
// Claude Code's public OAuth client id (v1 credential-proxy.ts:178).
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Refresh when less than 2h remain (v1 REFRESH_MARGIN_MS). */
const REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;
/** Re-check every 30 minutes (v1 REFRESH_CHECK_INTERVAL_MS). */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

const STATE_PATH = process.env.OAUTH_STATE_PATH || '/state/oauth-state.json';
const ONECLI_URL = required('ONECLI_URL');
const ONECLI_API_KEY = required('ONECLI_API_KEY');
const SECRET_ID = required('ONECLI_SECRET_ID');

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[refresher] FATAL: ${name} is not set`);
    process.exit(1);
  }
  return v;
}

function log(msg, extra) {
  console.log(`[refresher] ${new Date().toISOString()} ${msg}`, extra ? JSON.stringify(extra) : '');
}

const fs = require('fs');

/**
 * State file holds the refresh token, which ROTATES on every use — losing it
 * means re-seeding by hand from BKK. The vault cannot hold it instead: OneCLI
 * exposes no way to read a secret value back (verified — no GET /v1/secrets/:id,
 * and `secrets list` omits the value), so a write-only vault cannot serve as
 * the sidecar's own source of truth.
 */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    console.error(`[refresher] FATAL: cannot read ${STATE_PATH}: ${err.message}`);
    console.error('[refresher] Seed it with {"refreshToken":"...","expiresAt":0} from BKK.');
    process.exit(1);
  }
}

function writeState(state) {
  // Write-then-rename so a crash mid-write cannot leave a truncated file and
  // strand the only copy of the refresh token.
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
}

async function refresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`token endpoint ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = JSON.parse(body);
  if (!data.access_token) {
    throw new Error(`no access_token in response: ${body.slice(0, 300)}`);
  }
  return data;
}

async function pushToVault(accessToken) {
  const res = await fetch(`${ONECLI_URL}/v1/secrets/${SECRET_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ONECLI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ value: accessToken }),
  });
  if (!res.ok) {
    throw new Error(`vault update ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

async function checkAndRefresh() {
  const state = readState();
  const remaining = (state.expiresAt ?? 0) - Date.now();

  if (remaining > REFRESH_MARGIN_MS) {
    log('token still fresh, skipping', { hoursLeft: +(remaining / 3600000).toFixed(2) });
    return;
  }

  log('refreshing', { hoursLeft: +(remaining / 3600000).toFixed(2) });
  const data = await refresh(state.refreshToken);

  // Persist BEFORE touching the vault: the old refresh token is already spent,
  // so if we crash here without saving, the only usable one is gone.
  writeState({
    refreshToken: data.refresh_token || state.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 0) * 1000,
    updatedAt: new Date().toISOString(),
  });
  if (data.refresh_token && data.refresh_token !== state.refreshToken) {
    log('refresh token rotated and persisted');
  }

  await pushToVault(data.access_token);
  log('vault updated', {
    expiresAt: new Date(Date.now() + (data.expires_in ?? 0) * 1000).toISOString(),
  });
}

async function tick() {
  try {
    await checkAndRefresh();
  } catch (err) {
    // Never exit on a failed cycle: a transient network blip should not take
    // the loop down and silently stop all future refreshes. The 2h margin
    // leaves room for several retries before anything actually expires.
    console.error(`[refresher] cycle failed: ${err.message}`);
  }
}

log('starting', { checkIntervalMin: CHECK_INTERVAL_MS / 60000, statePath: STATE_PATH });
tick();
setInterval(tick, CHECK_INTERVAL_MS);
