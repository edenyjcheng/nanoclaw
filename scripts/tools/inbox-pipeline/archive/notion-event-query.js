#!/usr/bin/env node
/**
 * Tool 7 — notion-event-query.js
 * Query the Notion Gmail Events DB for approved items and output them as JSON
 * so gcal-event-writer.js (Tool 5) can create the corresponding calendar events.
 *
 * Usage:
 *   node scripts/tools/inbox-pipeline/notion-event-query.js [--type Event|Task|all] [--dry-run]
 *   node scripts/tools/inbox-pipeline/notion-event-query.js --registered-updates
 *
 * Options:
 *   --type <filter>       Event | Task | Alert | all  (default: Event)
 *   --mark-added          After outputting, PATCH each page → Status = "Added to Calendar"
 *   --registered-updates  Query Added to Calendar + Registered=true + has GCal Event ID
 *                         (events needing title patched with "(Registered)" suffix)
 *   --dry-run             Skip PATCH calls; output only
 *
 * Output (stdout, last line):
 *   APPROVED_EVENTS: <JSON array>
 *   Each item:
 *   {
 *     pageId:       string   (Notion page ID — pass to gcal-event-writer --notion-page-id)
 *     title:        string
 *     date:         string | null   (ISO start date)
 *     end_date:     string | null   (ISO end date for multi-day events, null otherwise)
 *     time:         string | null   (e.g. "10:00am - 4:00pm")
 *     location:     string | null
 *     notes:        string | null
 *     emailSubject: string | null
 *     calendar:     string | null   (target calendar name, e.g. "Personal")
 *     msgId:        string | null
 *     sourceAccount:string | null
 *     type:         string          (Event | Task | Alert)
 *   }
 *
 * Logs: groups/telegram_main/logs/gmail-scan.log
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUP_DIR  = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const MEMORY_DIR = path.join(GROUP_DIR, 'memory');
const GMAIL_DIR  = path.join(MEMORY_DIR, 'tools', 'inbox-pipeline');
const LOGS_DIR   = path.join(GROUP_DIR, 'logs');
const KEY_FILE   = path.join(MEMORY_DIR, '.address-key.md');
const SCAN_LOG   = path.join(LOGS_DIR, 'gmail-scan.log');

const DB_ID          = '32b7c3af-c311-813f-8dae-f8516b39294f';
const NOTION_VERSION = '2022-06-28';

// --- CLI args ---
const args      = process.argv.slice(2);
const getArg    = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const hasFlag   = (flag) => args.includes(flag);

const typeFilter          = getArg('--type') || 'Event';
const markAdded           = hasFlag('--mark-added');
const dryRun              = hasFlag('--dry-run');
const doRegisteredUpdates = hasFlag('--registered-updates');

// --- Logging ---
function logLine(line) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const entry = `[${ts}] ${line}\n`;
  process.stdout.write(entry);
  if (!dryRun) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(SCAN_LOG, entry);
  }
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

// --- Notion API ---
async function notionRequest(method, urlPath, token, body) {
  const res = await fetch(`https://api.notion.com/v1${urlPath}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (data.object === 'error') throw new Error(`Notion API: ${data.message}`);
  return data;
}

// --- Query all Approved pages (paginated) ---
async function queryApproved(token, type) {
  const pages = [];
  let cursor;

  // Build filter: Status = Approved, optionally AND Type = <type>
  const statusFilter = { property: 'Status', select: { equals: 'Approved' } };
  const filter = (type && type !== 'all')
    ? { and: [statusFilter, { property: 'Type', select: { equals: type } }] }
    : statusFilter;

  do {
    const body = {
      filter,
      page_size: 100,
      sorts: [{ property: 'Event Date', direction: 'ascending' }],
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const data = await notionRequest('POST', `/databases/${DB_ID}/query`, token, body);
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return pages;
}

// --- Extract plain text from Notion rich_text property ---
function richText(prop) {
  return prop?.rich_text?.map(t => t.plain_text).join('') || null;
}

function selectVal(prop) {
  return prop?.select?.name || null;
}

function dateVal(prop) {
  return prop?.date?.start || null;
}

function dateEndVal(prop) {
  return prop?.date?.end || null;
}

function titleVal(prop) {
  return prop?.title?.map(t => t.plain_text).join('') || '(untitled)';
}

// --- Map Notion page → structured event object ---
function mapPage(page) {
  const props = page.properties;
  return {
    pageId:        page.id,
    title:         titleVal(props['Event Title']),
    date:          dateVal(props['Event Date']),
    end_date:      dateEndVal(props['Event Date']),
    time:          richText(props['Event Time']),
    location:      richText(props['Location']),
    notes:         richText(props['Notes']),
    emailSubject:  richText(props['Email Subject']),
    calendar:      selectVal(props['Calendar']),
    gcalEventId:   richText(props['GCal Event ID']),
    msgId:         richText(props['Gmail Msg ID']),
    sourceAccount: richText(props['Source Account']),
    type:          selectVal(props['Type']) || 'Event',
    registrationRequired: props['Registration Required']?.checkbox ?? false,
    registrationLink:     props['Registration Link']?.url || null,
    rsvpDeadline:         dateVal(props['RSVP Deadline']),
    registered:           props['Registered']?.checkbox ?? false,
  };
}

// --- Query events needing registration title patch ---
// Returns Added to Calendar rows where Registered=true and GCal Event ID is set.
// The Phase C check calls gcal-event-writer --event-id <id> --title "<title> (Registered)" for each.
async function queryRegisteredUpdates(token) {
  const pages = [];
  let cursor;
  do {
    const body = {
      page_size: 100,
      filter: {
        and: [
          { property: 'Status', select: { equals: 'Added to Calendar' } },
          { property: 'Registered', checkbox: { equals: true } },
          { property: 'GCal Event ID', rich_text: { is_not_empty: true } },
        ],
      },
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const data = await notionRequest('POST', `/databases/${DB_ID}/query`, token, body);
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// --- PATCH page status ---
async function markPageAdded(pageId, token, status = 'Added to Calendar') {
  await notionRequest('PATCH', `/pages/${pageId}`, token, {
    properties: { 'Status': { select: { name: status } } },
  });
}

// --- Human-readable summary ---
function formatSummary(events) {
  if (events.length === 0) return 'No approved events found.';
  const lines = [`${events.length} approved event(s) ready for calendar:\n`];
  events.forEach((e, i) => {
    lines.push(`[${i + 1}] ${e.title}`);
    if (e.date) lines.push(`    Date: ${e.date}`);
    if (e.location) lines.push(`    Location: ${e.location}`);
    if (e.calendar) lines.push(`    Calendar: ${e.calendar}`);
    lines.push(`    Page ID: ${e.pageId}`);
    lines.push('');
  });
  return lines.join('\n');
}

// --- Main ---
async function main() {
  const token = loadNotionToken();

  // --registered-updates: find Added to Calendar rows where Registered=true + GCal ID set
  if (doRegisteredUpdates) {
    logLine(`NOTION_QUERY | mode=registered-updates`);
    const pages = await queryRegisteredUpdates(token);
    const events = pages.map(mapPage);
    logLine(`NOTION_QUERY | registered_updates_found=${events.length}`);
    console.log(`\nREGISTERED_UPDATES: ${JSON.stringify(events)}`);
    if (events.length === 0) {
      console.log('No registration title patches needed.');
    } else {
      console.log(`\n${events.length} event(s) need "(Registered)" title patch:`);
      events.forEach((e, i) => {
        console.log(`  [${i + 1}] "${e.title}" → "${e.title} (Registered)"`);
        console.log(`       gcalEventId: ${e.gcalEventId} | page: ${e.pageId}`);
      });
    }
    return;
  }

  logLine(`NOTION_QUERY | type=${typeFilter} | markAdded=${markAdded}`);

  const pages = await queryApproved(token, typeFilter === 'all' ? null : typeFilter);
  const events = pages.map(mapPage);

  logLine(`NOTION_QUERY | found=${events.length}`);

  if (markAdded && events.length > 0 && !dryRun) {
    for (const e of events) {
      const status = e.type === 'Task' ? 'Added to Todo' : 'Added to Calendar';
      await markPageAdded(e.pageId, token, status);
      logLine(`NOTION_MARK | page_id=${e.pageId} | title=${e.title.slice(0, 50)} | status=${status}`);
    }
  } else if (markAdded && dryRun) {
    logLine(`NOTION_MARK | dry-run — would patch ${events.length} pages`);
  }

  // Machine-readable output line — agent or pipeline reads this
  console.log(`\nAPPROVED_EVENTS: ${JSON.stringify(events)}`);

  // Human-readable summary
  console.log('\n' + '='.repeat(50));
  console.log(formatSummary(events));
  console.log('='.repeat(50));
}

main().catch(err => {
  console.error('\nNotion query failed:', err.message);
  process.exit(1);
});
