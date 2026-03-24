#!/usr/bin/env node
/**
 * Tool 5 — gcal-event-writer.js
 * Create a single event on Google Calendar, then update its Notion row to
 * Status = "Added to Calendar".
 *
 * Usage:
 *   node scripts/tools/inbox-pipeline/gcal-event-writer.js \
 *     --title "Team Standup" \
 *     --start 2026-03-25T10:00:00+08:00 \
 *     [--end   2026-03-25T11:00:00+08:00]  (defaults to start + 1h)
 *     [--account  Personal]
 *     [--location "Zoom https://zoom.us/j/123"]
 *     [--description "Weekly team sync"]
 *     [--notion-page-id <page_id>]   patch Notion row on success
 *     [--event-id <id>]              update existing event instead of creating new
 *     [--dry-run]
 *
 * Output (stdout, last line):
 *   EVENT_CREATED: {"eventId":"...","htmlLink":"...","calendarId":"..."}
 *
 * Logs: groups/telegram_main/logs/gcal-write.log
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUP_DIR  = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const MEMORY_DIR = path.join(GROUP_DIR, 'memory');
const GMAIL_DIR  = path.join(MEMORY_DIR, 'tools', 'inbox-pipeline');
const LOGS_DIR   = path.join(GROUP_DIR, 'logs');
const KEY_FILE   = path.join(MEMORY_DIR, '.address-key.md');
const GCAL_CONFIG_FILE = path.join(GMAIL_DIR, 'gcal-config.json');
const WRITE_LOG  = path.join(LOGS_DIR, 'gcal-write.log');

const NOTION_VERSION = '2022-06-28';

// --- CLI args ---
const args    = process.argv.slice(2);
const getArg  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const hasFlag = (flag) => args.includes(flag);

const accountName   = getArg('--account') || 'Personal';
const calendarName  = getArg('--calendar') || null;
const titleArg      = getArg('--title');
const startArg      = getArg('--start');
const endArg        = getArg('--end');
const locationArg   = getArg('--location');
const descArg       = getArg('--description');
const notionPageId  = getArg('--notion-page-id');
const eventIdArg    = getArg('--event-id');   // if set: PATCH existing event
const dryRun        = hasFlag('--dry-run');

// In patch mode --title and --start are optional (only patch provided fields).
// In insert mode both are required.
if (!eventIdArg && (!titleArg || !startArg)) {
  console.error('Usage: gcal-event-writer.js --title <string> --start <ISO> [--end <ISO>] [--account <name>] [--calendar <name>]');
  console.error('       [--location <string>] [--description <string>] [--notion-page-id <id>] [--dry-run]');
  console.error('       [--event-id <id>]  update existing event (all other flags optional)');
  process.exit(1);
}

const eventStart = startArg ? new Date(startArg) : null;
if (eventStart && isNaN(eventStart.getTime())) {
  console.error('Invalid --start date. Use ISO 8601 format.');
  process.exit(1);
}

// Default end = start + 1 hour (insert only; patch leaves end unchanged if omitted)
const eventEnd = endArg
  ? new Date(endArg)
  : (eventStart ? new Date(eventStart.getTime() + 60 * 60 * 1000) : null);
if (eventEnd && isNaN(eventEnd.getTime())) {
  console.error('Invalid --end date. Use ISO 8601 format.');
  process.exit(1);
}
if (eventStart && eventEnd && eventStart >= eventEnd) {
  console.error('--start must be before --end.');
  process.exit(1);
}

// --- Logging ---
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function logLine(line) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const entry = `[${ts}] ${line}\n`;
  process.stdout.write(entry);
  if (!dryRun) {
    ensureDir(LOGS_DIR);
    fs.appendFileSync(WRITE_LOG, entry);
  }
}

// --- Encryption ---
function loadEncryptionKey() {
  const content = fs.readFileSync(KEY_FILE, 'utf8');
  const match = content.match(/KEY:\s*([a-f0-9]{64})/m);
  if (!match) throw new Error('No valid KEY found in .address-key.md');
  return Buffer.from(match[1], 'hex');
}

function decrypt(ciphertext, key) {
  const { iv, data } = JSON.parse(ciphertext);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
}

// --- Notion token ---
function loadNotionToken() {
  const content = fs.readFileSync(KEY_FILE, 'utf8');
  const sectionMatch = content.match(/# Notion API Token[\s\S]*?(?=\n#|$)/i);
  if (!sectionMatch) throw new Error('Notion API Token section not found in .address-key.md');
  const section = sectionMatch[0];
  const enc = section.match(/ENCRYPTED:\s*([a-f0-9]+)/)?.[1];
  const key = section.match(/KEY:\s*([a-f0-9]{64})/)?.[1];
  const iv  = section.match(/IV:\s*([a-f0-9]{32})/)?.[1];
  if (!enc || !key || !iv) throw new Error('Notion token fields (ENCRYPTED/KEY/IV) missing in .address-key.md');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
  return decipher.update(enc, 'hex', 'utf8') + decipher.final('utf8');
}

// --- Notion PATCH ---
async function patchNotion(pageId, token, properties) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  });
  const data = await res.json();
  if (data.object === 'error') throw new Error(`Notion PATCH: ${data.message}`);
  return data;
}

// --- Config ---
function loadGcalConfig() {
  if (!fs.existsSync(GCAL_CONFIG_FILE)) throw new Error(`gcal-config.json not found: ${GCAL_CONFIG_FILE}`);
  return JSON.parse(fs.readFileSync(GCAL_CONFIG_FILE, 'utf8'));
}

function getAccount(config, name) {
  const account = config.accounts.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (!account) throw new Error(`No gcal account "${name}" in gcal-config.json`);
  if (!account.enabled) throw new Error(`Account "${name}" is disabled in gcal-config.json`);
  return account;
}

// --- Main ---
async function main() {
  const key     = loadEncryptionKey();
  const config  = loadGcalConfig();
  const account = getAccount(config, accountName);

  const tokenFile = path.join(GMAIL_DIR, account.token_file);
  if (!fs.existsSync(tokenFile)) throw new Error(`Token file not found: ${tokenFile}`);

  const tokens = JSON.parse(decrypt(fs.readFileSync(tokenFile, 'utf8'), key));

  const { client_id, client_secret } = (() => {
    const credsFile = path.join(GMAIL_DIR, `.creds-${accountName.toLowerCase()}.enc`);
    if (fs.existsSync(credsFile)) {
      const creds = JSON.parse(decrypt(fs.readFileSync(credsFile, 'utf8'), key));
      return creds.installed || creds.web;
    }
    return { client_id: tokens.client_id || '', client_secret: tokens.client_secret || '' };
  })();

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001/oauth2callback');
  oAuth2Client.setCredentials(tokens);

  // Auto-save refreshed tokens
  oAuth2Client.on('tokens', (newTokens) => {
    if (!dryRun) {
      const merged = { ...tokens, ...newTokens };
      const iv = crypto.randomBytes(16);
      const encKey = loadEncryptionKey();
      const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(merged), 'utf8'), cipher.final()]);
      fs.writeFileSync(tokenFile, JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex') }), 'utf8');
    }
  });

  const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

  // Resolve calendarId: --calendar name → gcal-config.json calendars[] → calendar_id
  // Falls back to account.default_calendar_id if --calendar not provided.
  let calendarId = account.default_calendar_id || 'primary';
  if (calendarName) {
    const configCalendars = (config.calendars || [])
      .filter(c => c.account.toLowerCase() === accountName.toLowerCase());
    const match = configCalendars.find(c => c.name.toLowerCase() === calendarName.toLowerCase());
    if (!match) throw new Error(`Calendar "${calendarName}" not found in gcal-config.json for account "${accountName}"`);
    calendarId = match.calendar_id;
  }

  const op = eventIdArg ? 'patch' : 'insert';
  logLine(`GCAL_WRITE | op=${op} | account=${accountName} | calendar=${calendarName || 'default'} | calendarId=${calendarId} | title=${titleArg || '(unchanged)'} | start=${startArg || '(unchanged)'}`);

  if (dryRun) {
    console.log(`\n[DRY RUN] Would ${op} event${eventIdArg ? ` (${eventIdArg})` : ''}:`);
    if (titleArg)    console.log(`  Title:    ${titleArg}`);
    if (startArg)    console.log(`  Start:    ${startArg}`);
    if (eventEnd)    console.log(`  End:      ${eventEnd.toISOString()}`);
    if (locationArg) console.log(`  Location: ${locationArg}`);
    if (descArg)     console.log(`  Desc:     ${descArg}`);
    if (notionPageId) console.log(`  Notion:   would patch page ${notionPageId} → Added to Calendar + GCal Event ID`);
    console.log(`\nEVENT_CREATED: ${JSON.stringify({ eventId: eventIdArg || 'dry-run', htmlLink: 'dry-run', calendarId })}`);
    return;
  }

  let eventId, htmlLink;

  if (eventIdArg) {
    // PATCH — only include fields that were explicitly provided
    const patchBody = {};
    if (titleArg)    patchBody.summary  = titleArg;
    if (eventStart)  patchBody.start    = { dateTime: eventStart.toISOString() };
    if (eventEnd)    patchBody.end      = { dateTime: eventEnd.toISOString() };
    if (locationArg) patchBody.location = locationArg;
    if (descArg)     patchBody.description = descArg;

    const patched = await calendar.events.patch({
      calendarId,
      eventId: eventIdArg,
      resource: patchBody,
    });
    eventId  = patched.data.id;
    htmlLink = patched.data.htmlLink;
    logLine(`GCAL_WRITE | status=ok | op=patch | eventId=${eventId} | htmlLink=${htmlLink}`);
  } else {
    // INSERT — full event body with reminders
    const eventBody = {
      summary: titleArg,
      start:   { dateTime: eventStart.toISOString() },
      end:     { dateTime: eventEnd.toISOString() },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 30 },
          { method: 'email', minutes: 24 * 60 },
        ],
      },
    };
    if (locationArg) eventBody.location    = locationArg;
    if (descArg)     eventBody.description = descArg;

    const inserted = await calendar.events.insert({ calendarId, resource: eventBody });
    eventId  = inserted.data.id;
    htmlLink = inserted.data.htmlLink;
    logLine(`GCAL_WRITE | status=ok | op=insert | eventId=${eventId} | htmlLink=${htmlLink}`);
  }

  // Update Notion row if page ID was provided
  if (notionPageId) {
    try {
      const notionToken = loadNotionToken();
      await patchNotion(notionPageId, notionToken, {
        'Status':        { select: { name: 'Added to Calendar' } },
        'GCal Event ID': { rich_text: [{ text: { content: eventId } }] },
      });
      logLine(`NOTION_STATUS | page_id=${notionPageId} | status=Added to Calendar | gcalEventId=${eventId} | status=ok`);
    } catch (err) {
      logLine(`NOTION_STATUS | page_id=${notionPageId} | status=error | error=${err.message}`);
      // Don't fail the whole script — the calendar event was already created
    }
  }

  const result = { eventId, htmlLink, calendarId };
  console.log(`\nEVENT_CREATED: ${JSON.stringify(result)}`);
  console.log(`\n✅ Event ${eventIdArg ? 'updated' : 'created'}: ${titleArg || eventIdArg}`);
  console.log(`   ${htmlLink}`);
  if (notionPageId) console.log(`   Notion row updated → Added to Calendar`);
}

main().catch(err => {
  console.error('\nEvent writer failed:', err.message);
  process.exit(1);
});
