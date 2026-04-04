#!/usr/bin/env node
/**
 * Tool 4 — gcal-conflict-checker.js
 * Check if a proposed event time conflicts with existing Google Calendar events.
 * Optionally suggests the next free 1-hour slot within 3 days.
 *
 * Usage:
 *   node scripts/tools/inbox-pipeline/gcal-conflict-checker.js \
 *     --start 2026-03-25T10:00:00+08:00 \
 *     --end   2026-03-25T11:00:00+08:00 \
 *     [--account Personal] [--suggest-slots] [--dry-run]
 *
 * Options:
 *   --account <name>    Calendar account from gcal-config.json (default: Personal)
 *   --calendar <name>   Calendar name from Notion "Calendar" column (e.g. "Family").
 *                       If omitted, checks all calendars for the account.
 *   --start <ISO>       Proposed event start (ISO 8601)
 *   --end   <ISO>       Proposed event end   (ISO 8601)
 *   --suggest-slots     Also find the next free 1h slot within 3 days
 *   --dry-run           No log writes
 *
 * Output (stdout, last line):
 *   CONFLICT_RESULT: <JSON>
 *   {
 *     hasConflict: boolean,
 *     conflicts:   [{ title, start, end }],
 *     message:     string  (human-readable, ready to send to Telegram),
 *     freeSlots:   [{ start, end }]  (only when --suggest-slots)
 *   }
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
const SCAN_LOG   = path.join(LOGS_DIR, 'gcal-conflict.log');

// --- CLI args ---
const args = process.argv.slice(2);
const getArg  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const hasFlag = (flag) => args.includes(flag);

const accountName  = getArg('--account') || 'Personal';
const calendarName = getArg('--calendar') || null;
const startArg     = getArg('--start');
const endArg       = getArg('--end');
const suggestSlots = hasFlag('--suggest-slots');
const dryRun       = hasFlag('--dry-run');

// --- Validation ---
if (!startArg || !endArg) {
  console.error('Usage: gcal-conflict-checker.js --start <ISO> --end <ISO> [--account <name>] [--calendar <name>] [--suggest-slots]');
  process.exit(1);
}

const eventStart = new Date(startArg);
const eventEnd   = new Date(endArg);

if (isNaN(eventStart.getTime()) || isNaN(eventEnd.getTime())) {
  console.error('Invalid --start or --end date. Use ISO 8601 format.');
  process.exit(1);
}
if (eventStart >= eventEnd) {
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
    fs.appendFileSync(SCAN_LOG, entry);
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

// --- Date formatting for display ---
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// --- Build conflict message for Telegram ---
function buildConflictMessage(conflicts, eventStartISO, eventEndISO) {
  const lines = [
    `⚠️ *Conflict detected* for ${fmtDate(eventStartISO)}–${fmtTime(eventEndISO)}:\n`,
  ];
  for (const c of conflicts) {
    lines.push(`• _${c.title}_ — ${fmtDate(c.start)}–${fmtTime(c.end)}`);
  }
  lines.push('');
  lines.push('[1] Reschedule  [2] Skip this event  [3] Suggest free slot  [4] Add anyway');
  return lines.join('\n');
}

// --- Find next free 1-hour slots within 3 days ---
// Looks at working hours (08:00–22:00 local) in 30-min steps.
async function findFreeSlots(calendar, calendarIds, afterDate, durationMs, maxSlots = 3) {
  const searchEnd = new Date(afterDate.getTime() + 3 * 24 * 60 * 60 * 1000);

  // Fetch events from all calendars in the 3-day window
  const allItems = (await Promise.all(calendarIds.map(calId =>
    calendar.events.list({
      calendarId: calId,
      timeMin: afterDate.toISOString(),
      timeMax: searchEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    }).then(res => res.data.items || [])
  ))).flat();

  const busy = allItems
    .filter(e => e.start?.dateTime) // exclude all-day events
    .map(e => ({ start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) }));

  const slots = [];
  // Step through time in 30-min increments
  let cursor = new Date(afterDate);
  // Round up to next 30-min boundary
  const mins = cursor.getMinutes();
  if (mins > 0 && mins <= 30) cursor.setMinutes(30, 0, 0);
  else if (mins > 30) { cursor.setHours(cursor.getHours() + 1, 0, 0, 0); }
  else cursor.setSeconds(0, 0);

  while (cursor < searchEnd && slots.length < maxSlots) {
    const slotEnd = new Date(cursor.getTime() + durationMs);

    // Only within 08:00–22:00
    const hour = cursor.getHours();
    if (hour < 8) {
      cursor.setHours(8, 0, 0, 0);
      continue;
    }
    if (slotEnd.getHours() > 22 || (slotEnd.getHours() === 22 && slotEnd.getMinutes() > 0)) {
      // Skip to next day 08:00
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(8, 0, 0, 0);
      continue;
    }

    // Check for overlap with any busy period
    const overlaps = busy.some(b => cursor < b.end && slotEnd > b.start);
    if (!overlaps) {
      slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
      cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
    } else {
      cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
    }
  }

  return slots;
}

// --- Main ---
async function main() {
  const key    = loadEncryptionKey();
  const config = loadGcalConfig();
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
    // Fallback: reconstruct from token (no client_id/secret needed for refresh if already in token)
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

  const calendar   = google.calendar({ version: 'v3', auth: oAuth2Client });
  const defaultCalId = account.default_calendar_id || 'primary';
  const configCalendars = (config.calendars || [])
    .filter(c => c.account.toLowerCase() === accountName.toLowerCase());

  // If --calendar given, resolve to that specific calendar ID.
  // Otherwise check all calendars for the account.
  let allCalendarIds;
  if (calendarName) {
    const match = configCalendars.find(c => c.name.toLowerCase() === calendarName.toLowerCase());
    if (!match) throw new Error(`Calendar "${calendarName}" not found in gcal-config.json for account "${accountName}"`);
    allCalendarIds = [match.calendar_id];
  } else {
    const accountCalIds = configCalendars.map(c => c.calendar_id);
    allCalendarIds = [...new Set([defaultCalId, ...accountCalIds])];
  }

  // Query window: start-30min to end+30min
  const timeMin = new Date(eventStart.getTime() - 30 * 60 * 1000).toISOString();
  const timeMax = new Date(eventEnd.getTime()   + 30 * 60 * 1000).toISOString();

  logLine(`CONFLICT_CHECK | account=${accountName} | calendars=${allCalendarIds.join(',')} | start=${startArg} | end=${endArg}`);

  // Query all calendars concurrently
  const allItems = (await Promise.all(allCalendarIds.map(calId =>
    calendar.events.list({
      calendarId: calId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    }).then(res => res.data.items || [])
  ))).flat();

  const candidates = allItems;

  // A conflict is an event whose time overlaps [eventStart, eventEnd)
  const conflicts = candidates
    .filter(e => {
      if (!e.start?.dateTime) return false; // skip all-day events
      const s = new Date(e.start.dateTime);
      const en = new Date(e.end.dateTime);
      return s < eventEnd && en > eventStart;
    })
    .map(e => ({
      title: e.summary || '(no title)',
      start: e.start.dateTime,
      end:   e.end.dateTime,
      eventId: e.id,
    }));

  logLine(`CONFLICT_CHECK | conflicts=${conflicts.length} | candidates=${candidates.length}`);
  for (const c of conflicts) {
    logLine(`CONFLICT | title=${c.title} | start=${c.start} | end=${c.end}`);
  }

  const durationMs = eventEnd.getTime() - eventStart.getTime();
  let freeSlots = [];

  if (suggestSlots || conflicts.length > 0) {
    // Always fetch free slots when there's a conflict (agent can present [3])
    freeSlots = await findFreeSlots(calendar, allCalendarIds, eventEnd, durationMs);
    logLine(`FREE_SLOTS | found=${freeSlots.length}`);
  }

  const result = {
    hasConflict: conflicts.length > 0,
    conflicts,
    message: conflicts.length > 0
      ? buildConflictMessage(conflicts, startArg, endArg)
      : `✅ No conflicts found for ${fmtDate(startArg)}–${fmtTime(endArg)}.`,
    freeSlots,
  };

  // Print structured result — agent reads this line
  console.log(`\nCONFLICT_RESULT: ${JSON.stringify(result)}`);

  // Human-readable summary
  if (conflicts.length > 0) {
    console.log('\n' + result.message);
    if (freeSlots.length > 0) {
      console.log('\nNext free slots:');
      freeSlots.forEach((s, i) => console.log(`  ${i + 1}. ${fmtDate(s.start)}–${fmtTime(s.end)}`));
    }
  } else {
    console.log('\n' + result.message);
  }
}

main().catch(err => {
  console.error('\nConflict checker failed:', err.message);
  process.exit(1);
});
