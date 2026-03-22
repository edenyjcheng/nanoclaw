#!/usr/bin/env node
/**
 * Tool 1 — gmail-auth-setup.js
 * One-time OAuth2 setup per Gmail account.
 *
 * Usage:
 *   node scripts/gmail-auth-setup.js --credentials ./credentials.json --account Personal
 *
 * Output:
 *   groups/telegram_main/memory/.gmail-token-{account}.enc  (encrypted OAuth token)
 *   groups/telegram_main/memory/gmail-config.json           (created/updated with account entry)
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const MEMORY_DIR = path.join(GROUP_DIR, 'memory');
const KEY_FILE = path.join(MEMORY_DIR, '.address-key.md');
const CONFIG_FILE = path.join(MEMORY_DIR, 'gmail-config.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

// --- CLI args ---
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const credentialsPath = getArg('--credentials');
const accountName = getArg('--account');

if (!credentialsPath || !accountName) {
  console.error('Usage: node gmail-auth-setup.js --credentials <path> --account <name>');
  console.error('Example: node gmail-auth-setup.js --credentials ./credentials.json --account Personal');
  process.exit(1);
}

if (!fs.existsSync(credentialsPath)) {
  console.error(`credentials.json not found at: ${credentialsPath}`);
  process.exit(1);
}

// --- Encryption helpers (AES-256-CBC) ---
function loadEncryptionKey() {
  if (!fs.existsSync(KEY_FILE)) {
    console.error(`Key file not found: ${KEY_FILE}`);
    console.error('Expected .address-key.md in memory directory.');
    process.exit(1);
  }
  const content = fs.readFileSync(KEY_FILE, 'utf8');
  // Parse KEY: <hex> line — take the first one
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
  return JSON.stringify({
    iv: iv.toString('hex'),
    data: encrypted.toString('hex'),
  });
}

function decrypt(ciphertext, key) {
  const { iv, data } = JSON.parse(ciphertext);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

// --- OAuth2 flow ---
async function runOAuthFlow(credentials) {
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const redirectUri = 'http://localhost:3000/oauth2callback';

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force refresh_token on every auth
  });

  console.log('\n=== Gmail OAuth2 Setup ===');
  console.log(`Account: ${accountName}`);
  console.log('\nOpen this URL in your browser:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization...');

  // Start local server to catch the redirect
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
    server.listen(3000, () => {
      // server ready
    });
    server.on('error', reject);
    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Timeout waiting for OAuth callback (5 min)'));
    }, 5 * 60 * 1000);
  });

  const { tokens } = await oAuth2Client.getToken(code);
  return tokens;
}

// --- Config helpers ---
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      accounts: [],
      keywords: [
        'invite', 'invitation', 'RSVP', 'event', 'webinar',
        'conference', 'registration', 'join us', 'deadline',
        'due date', 'meeting', 'appointment', 'seminar',
      ],
    };
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function upsertAccount(config, accountName, email, tokenFile) {
  const existing = config.accounts.findIndex(a => a.name === accountName);
  const entry = {
    name: accountName,
    email,
    credentials_file: path.basename(tokenFile),
    token_file: `.gmail-token-${accountName.toLowerCase()}.enc`,
    enabled: true,
    scan: {
      mode: 'interval',
      interval_hours: 6,
      schedule_cron: '0 */6 * * *',
      date_from: null,
      date_to: null,
    },
  };
  if (existing !== -1) {
    config.accounts[existing] = entry;
    console.log(`\nUpdated existing account entry: ${accountName}`);
  } else {
    config.accounts.push(entry);
    console.log(`\nAdded new account entry: ${accountName}`);
  }
  return config;
}

// --- Main ---
async function main() {
  const credentialsRaw = fs.readFileSync(credentialsPath, 'utf8');
  const credentials = JSON.parse(credentialsRaw);

  // Extract email hint from credentials if available
  const clientEmail = credentials.installed?.client_email || credentials.web?.client_email || null;

  // Run OAuth flow
  const tokens = await runOAuthFlow(credentials);

  if (!tokens.refresh_token) {
    console.warn('\nWarning: No refresh_token received.');
    console.warn('This usually means the account was already authorized previously.');
    console.warn('Revoke access at https://myaccount.google.com/permissions and re-run to get a fresh token.');
  }

  // Load encryption key
  const key = loadEncryptionKey();

  // Encrypt and save token
  const tokenFile = path.join(MEMORY_DIR, `.gmail-token-${accountName.toLowerCase()}.enc`);
  const encryptedToken = encrypt(JSON.stringify(tokens), key);
  fs.writeFileSync(tokenFile, encryptedToken, 'utf8');
  console.log(`\nToken saved (encrypted): ${tokenFile}`);

  // Determine email — ask user if not in credentials
  let email = clientEmail;
  if (!email) {
    // Try to get it from the id_token if present
    if (tokens.id_token) {
      const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString());
      email = payload.email || null;
    }
  }
  if (!email) {
    email = `${accountName.toLowerCase()}@gmail.com`;
    console.log(`\nCould not detect email automatically. Using placeholder: ${email}`);
    console.log(`Edit gmail-config.json to set the correct email for account "${accountName}".`);
  } else {
    console.log(`Detected email: ${email}`);
  }

  // Update gmail-config.json
  const config = loadConfig();
  const updatedConfig = upsertAccount(config, accountName, email, tokenFile);
  saveConfig(updatedConfig);
  console.log(`Config updated: ${CONFIG_FILE}`);

  console.log('\n=== Setup Complete ===');
  console.log(`Account "${accountName}" is ready.`);
  console.log('Next step: build Tool 2 (gmail-scanner.js) to start scanning emails.');
}

main().catch(err => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
