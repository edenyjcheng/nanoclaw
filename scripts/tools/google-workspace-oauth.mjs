#!/usr/bin/env node
/**
 * One-shot OAuth2 setup for Google Workspace MCP.
 * Authorizes all combined scopes in a single flow and writes GOOGLE_REFRESH_TOKEN to .env.
 *
 * Usage: node scripts/tools/google-workspace-oauth.mjs
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const ENV_FILE = path.join(ROOT, '.env');

const CALLBACK_PORT = 3005;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth2callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/tasks',
];

// Read a key from .env file
function readEnv(key) {
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

// Write or replace a key in .env file
function writeEnv(key, value) {
  let content = fs.readFileSync(ENV_FILE, 'utf8');
  const pattern = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (pattern.test(content)) {
    content = content.replace(pattern, line);
  } else {
    content = content.trimEnd() + '\n' + line + '\n';
  }
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

async function main() {
  const clientId = readEnv('GOOGLE_OAUTH_CLIENT_ID') || readEnv('GOOGLE_CLIENT_ID');
  const clientSecret = readEnv('GOOGLE_OAUTH_CLIENT_SECRET') || readEnv('GOOGLE_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    console.error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in .env');
    process.exit(1);
  }

  // Build auth URL manually (no googleapis dep needed)
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  console.log('\n=== Google Workspace MCP — Combined OAuth Setup ===\n');
  console.log('Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization on port', CALLBACK_PORT, '...\n');

  // Write a clickable HTML file for easy browser opening
  const htmlPath = path.join(ROOT, 'oauth-login.html');
  fs.writeFileSync(htmlPath, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Google OAuth Login</title></head>
<body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0;">
<div style="text-align:center;max-width:600px;">
<h1>Google Workspace OAuth</h1>
<p>Click the button below to authorize NanoClaw.</p>
<a href="${authUrl}" style="display:inline-block;padding:16px 32px;background:#4285f4;color:white;text-decoration:none;border-radius:8px;font-size:18px;margin:20px 0;">Sign in with Google</a>
<p style="color:#888;font-size:12px;margin-top:30px;">Callback port: ${CALLBACK_PORT}</p>
</div></body></html>\n`);
  console.log(`HTML login page written to: ${htmlPath}`);
  console.log('Open oauth-login.html in your browser and click the button.\n');

  // Wait for the OAuth callback
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/oauth2callback') return;

      const error = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');
      const authCode = url.searchParams.get('code');

      if (error) {
        res.writeHead(400);
        res.end(`<h2>Authorization failed: ${error}</h2>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400);
        res.end('<h2>State mismatch — possible CSRF</h2>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Authorization successful! You can close this tab.</h2>');
      server.close();
      resolve(authCode);
    });

    server.listen(CALLBACK_PORT, () => {});
    server.on('error', reject);

    setTimeout(() => {
      server.close();
      reject(new Error('Timeout waiting for OAuth callback (5 minutes)'));
    }, 5 * 60 * 1000);
  });

  console.log('Authorization code received. Exchanging for tokens...');

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Token exchange failed: ${tokenRes.status} ${err}`);
  }

  const tokens = await tokenRes.json();

  if (!tokens.refresh_token) {
    console.error('\nNo refresh_token received.');
    console.error('This usually means this Google account already authorized this app.');
    console.error('Go to https://myaccount.google.com/permissions, revoke "my-claw-assistant", then re-run.');
    process.exit(1);
  }

  console.log('Tokens received. Writing GOOGLE_REFRESH_TOKEN to .env...');
  writeEnv('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);

  console.log('\n=== Done ===');
  console.log('GOOGLE_REFRESH_TOKEN written to .env');
  console.log('\nNext step:');
  console.log('  docker-compose up -d google-workspace-mcp');
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
