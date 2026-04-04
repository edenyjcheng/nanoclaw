#!/usr/bin/env node
/**
 * Tool 3 — gcal-auth-setup.js
 * One-time OAuth2 setup per Google Calendar account.
 * Defaults to the Personal account credentials saved by Tool 1 (auth-setup.js).
 *
 * Usage:
 *   node scripts/tools/inbox-pipeline/gcal-auth-setup.js
 *                                             ← uses Personal account credentials (.creds-personal.enc)
 *   node scripts/tools/inbox-pipeline/gcal-auth-setup.js --account Work
 *                                             ← loads .creds-work.enc (must have run auth-setup.js for Work first)
 *   node scripts/tools/inbox-pipeline/gcal-auth-setup.js --credentials ./credentials.json [--account Personal]
 *                                             ← use raw credentials.json directly
 *
 * Output:
 *   groups/telegram_main/memory/tools/inbox-pipeline/.token-gcal-{account}.enc  (encrypted OAuth token)
 *   groups/telegram_main/memory/tools/inbox-pipeline/gcal-config.json           (created/updated with account entry)
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUP_DIR  = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const MEMORY_DIR = path.join(GROUP_DIR, 'memory');
const GMAIL_DIR  = path.join(MEMORY_DIR, 'tools', 'inbox-pipeline');
const KEY_FILE   = path.join(MEMORY_DIR, '.address-key.md');
const GCAL_CONFIG_FILE = path.join(GMAIL_DIR, 'gcal-config.json');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
];

// --- CLI args ---
const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const accountName   = getArg('--account') || 'Personal';
const credentialsPath = getArg('--credentials');  // optional — defaults to .creds-{name}.enc

// --- Encryption helpers (AES-256-CBC) ---
function loadEncryptionKey() {
  if (!fs.existsSync(KEY_FILE)) {
    console.error(`Key file not found: ${KEY_FILE}`);
    process.exit(1);
  }
  const content = fs.readFileSync(KEY_FILE, 'utf8');
  const match = content.match(/KEY:\s*([a-f0-9]{64})/m);
  if (!match) {
    console.error('Could not find a valid KEY: <hex64> line in .address-key.md');
    process.exit(1);
  }
  return Buffer.from(match[1], 'hex');
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex') });
}

function decrypt(ciphertext, key) {
  const { iv, data } = JSON.parse(ciphertext);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
}

// --- Load credentials ---
// If --credentials path given: read directly.
// Otherwise: decrypt .creds-{account}.enc saved by auth-setup.js (Tool 1).
function loadCredentials(key) {
  if (credentialsPath) {
    if (!fs.existsSync(credentialsPath)) {
      console.error(`credentials.json not found: ${credentialsPath}`);
      process.exit(1);
    }
    return fs.readFileSync(credentialsPath, 'utf8');
  }

  const encFile = path.join(GMAIL_DIR, `.creds-${accountName.toLowerCase()}.enc`);
  if (!fs.existsSync(encFile)) {
    console.error(`No credentials found for account "${accountName}".`);
    console.error(`Expected encrypted credentials at: ${encFile}`);
    console.error(`Run auth-setup.js --account ${accountName} first, or pass --credentials <path>.`);
    process.exit(1);
  }
  console.log(`Loading credentials from: ${encFile}`);
  return decrypt(fs.readFileSync(encFile, 'utf8'), key);
}

// --- OAuth2 flow ---
async function runOAuthFlow(credentials) {
  const { client_id, client_secret } = credentials.installed || credentials.web;
  const redirectUri = 'http://localhost:3000/oauth2callback';

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n=== Google Calendar OAuth2 Setup ===');
  console.log(`Account: ${accountName}`);
  console.log('\nOpen this URL in your browser:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization...');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:3000');
      if (url.pathname === '/oauth2callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (error) {
          res.end(`<h2>Authorization failed: ${error}</h2>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        res.end('<h2>Authorization successful! You can close this tab.</h2>');
        server.close();
        resolve(code);
      }
    });
    server.listen(3000, () => {});
    server.on('error', reject);
    setTimeout(() => {
      server.close();
      reject(new Error('Timeout waiting for OAuth callback (5 min)'));
    }, 5 * 60 * 1000);
  });

  const { tokens } = await oAuth2Client.getToken(code);
  return tokens;
}

// --- Config helpers ---
function loadGcalConfig() {
  if (!fs.existsSync(GCAL_CONFIG_FILE)) return { accounts: [] };
  return JSON.parse(fs.readFileSync(GCAL_CONFIG_FILE, 'utf8'));
}

function saveGcalConfig(config) {
  fs.writeFileSync(GCAL_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function upsertAccount(config, name, tokenFile) {
  const existing = config.accounts.findIndex(a => a.name === name);
  const entry = {
    name,
    token_file: path.basename(tokenFile),
    default_calendar_id: 'primary',
    enabled: true,
  };
  if (existing !== -1) {
    config.accounts[existing] = entry;
    console.log(`Updated existing gcal account entry: ${name}`);
  } else {
    config.accounts.push(entry);
    console.log(`Added new gcal account entry: ${name}`);
  }
  return config;
}

// --- Main ---
async function main() {
  const key = loadEncryptionKey();
  const credentialsRaw = loadCredentials(key);
  const credentials = JSON.parse(credentialsRaw);

  const tokens = await runOAuthFlow(credentials);

  if (!tokens.refresh_token) {
    console.warn('\nWarning: No refresh_token received.');
    console.warn('Revoke access at https://myaccount.google.com/permissions and re-run.');
  }

  fs.mkdirSync(GMAIL_DIR, { recursive: true });
  const tokenFile = path.join(GMAIL_DIR, `.token-gcal-${accountName.toLowerCase()}.enc`);
  fs.writeFileSync(tokenFile, encrypt(JSON.stringify(tokens), key), 'utf8');
  console.log(`\nCalendar token saved (encrypted): ${tokenFile}`);

  const config = loadGcalConfig();
  saveGcalConfig(upsertAccount(config, accountName, tokenFile));
  console.log(`Config updated: ${GCAL_CONFIG_FILE}`);

  console.log('\n=== Setup Complete ===');
  console.log(`Account "${accountName}" is ready for Google Calendar access.`);
  console.log('Next step: use Tool 4 (gcal-conflict-checker.js) or Tool 5 (gcal-event-writer.js).');
}

main().catch(err => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
