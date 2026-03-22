#!/usr/bin/env node
/**
 * Tool 2b — gmail-notion-push.js
 * Push extracted events from gmail-events-pending.json → Notion Gmail Inbox Items DB.
 * Tracks pushed items locally to avoid duplicates.
 *
 * Usage:
 *   node scripts/gmail-notion-push.js [--dry-run] [--limit N]
 *   node scripts/gmail-notion-push.js --sync
 *   node scripts/gmail-notion-push.js --clean [--status <Pending|Approved|...>] [--dry-run]
 *
 * Commands:
 *   (default)   Push pending events, skip already-indexed items
 *   --sync      Query Notion DB, reconcile with local index, report orphans
 *   --clean     Archive Notion pages + clear local index (all or by --status)
 *
 * Options:
 *   --dry-run   Show what would happen, no API calls or file writes
 *   --limit N   Only push the first N new items
 *   --status S  Filter by Status for --clean (e.g. Pending, Approved)
 *
 * Index file: groups/telegram_main/memory/gmail-notion-index.json
 * Logs:       groups/telegram_main/logs/gmail-scan.log
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR   = path.join(__dirname, '..', 'groups', 'telegram_main', 'memory');
const LOGS_DIR     = path.join(__dirname, '..', 'groups', 'telegram_main', 'logs');
const PENDING_FILE = path.join(MEMORY_DIR, 'gmail-events-pending.json');
const INDEX_FILE   = path.join(MEMORY_DIR, 'gmail-notion-index.json');
const SCAN_LOG     = path.join(LOGS_DIR, 'gmail-scan.log');
const ENV_FILE     = path.join(__dirname, '..', '.env');

const DB_ID          = '32b7c3af-c311-813f-8dae-f8516b39294f';
const DB_URL         = 'https://www.notion.so/32b7c3afc311813f8daef8516b39294f';
const NOTION_VERSION = '2022-06-28';

// --- CLI args ---
const args     = process.argv.slice(2);
const dryRun   = args.includes('--dry-run');
const doSync   = args.includes('--sync');
const doClean  = args.includes('--clean');
const limitArg = args.indexOf('--limit');
const limit    = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : null;
const statusArg = args.indexOf('--status');
const statusFilter = statusArg !== -1 ? args[statusArg + 1] : null;

// --- Env loader ---
function loadEnv() {
  const raw = fs.readFileSync(ENV_FILE, 'utf8');
  const env = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

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

// --- Local index helpers ---
function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return {};
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
}

function saveIndex(index) {
  if (!dryRun) fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

function makeIndexKey(event) {
  const slug = (event.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  return `${event.source?.msg_id || 'unknown'}:${slug}`;
}

// --- Date parser ---
function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

// --- Notion API helpers ---
async function notionRequest(method, path, token, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
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

async function queryAllPages(token, statusFilter) {
  const pages = [];
  let cursor = undefined;
  do {
    const filter = statusFilter
      ? { property: 'Status', select: { equals: statusFilter } }
      : undefined;
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}), ...(filter ? { filter } : {}) };
    const data = await notionRequest('POST', `/databases/${DB_ID}/query`, token, body);
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// --- Build Notion page properties ---
function buildProperties(event) {
  const props = {
    'Event Title':    { title: [{ text: { content: event.title || '(untitled)' } }] },
    'Status':         { select: { name: 'Pending' } },
    'Type':           { select: { name: event.type || 'Event' } },
    'From':           { rich_text: [{ text: { content: event.source?.from || '' } }] },
    'Source Account': { rich_text: [{ text: { content: event.source?.account || 'Personal' } }] },
    'Gmail Msg ID':   { rich_text: [{ text: { content: event.source?.msg_id || '' } }] },
  };

  const dateStr = parseDate(event.date);
  if (dateStr) props['Event Date'] = { date: { start: dateStr } };
  if (event.location) props['Location'] = { rich_text: [{ text: { content: event.location } }] };
  if (typeof event.registration_required === 'boolean')
    props['Registration Required'] = { checkbox: event.registration_required };
  if (event.registration_link) props['Registration Link'] = { url: event.registration_link };
  const rsvpDate = parseDate(event.rsvp_deadline);
  if (rsvpDate) props['RSVP Deadline'] = { date: { start: rsvpDate } };
  const notes = [event.notes, event.source?.subject ? `Source: ${event.source.subject}` : null]
    .filter(Boolean).join(' | ');
  if (notes) props['Notes'] = { rich_text: [{ text: { content: notes.slice(0, 2000) } }] };

  return props;
}

// --- PUSH (default command) ---
async function cmdPush(token) {
  if (!fs.existsSync(PENDING_FILE)) {
    console.error(`No pending events file: ${PENDING_FILE}\nRun gmail-scanner.js first.`);
    process.exit(1);
  }

  let events = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  const index = loadIndex();

  // Filter out already-indexed events
  const newEvents = events.filter(e => !index[makeIndexKey(e)]);
  const skipped = events.length - newEvents.length;
  if (skipped > 0) console.log(`Skipping ${skipped} already-pushed item(s).`);

  const toProcess = limit ? newEvents.slice(0, limit) : newEvents;
  if (toProcess.length === 0) {
    console.log('No new events to push — all already in Notion.');
    return;
  }

  if (dryRun) console.log('[DRY RUN] No Notion API calls or index writes.\n');
  logLine(`NOTION_PUSH_START | new=${toProcess.length} | skipped=${skipped} | db=${DB_ID}`);

  let pushed = 0, failed = 0;
  for (const event of toProcess) {
    const key = makeIndexKey(event);
    const label = event.title?.slice(0, 50);

    if (dryRun) {
      console.log(`  [DRY RUN] Would push: ${event.title} (${event.source?.account})`);
      console.log(`    Date: ${event.date || 'unknown'} | Type: ${event.type || 'Event'}`);
      pushed++;
      continue;
    }

    try {
      const pageId = await notionRequest('POST', '/pages', token, {
        parent: { database_id: DB_ID },
        properties: buildProperties(event),
      }).then(d => d.id);

      index[key] = { page_id: pageId, title: event.title, msg_id: event.source?.msg_id, pushed_at: new Date().toISOString() };
      saveIndex(index);
      logLine(`NOTION_PUSH | title=${label} | msg_id=${event.source?.msg_id} | page_id=${pageId} | status=ok`);
      pushed++;
    } catch (err) {
      logLine(`NOTION_PUSH | title=${label} | msg_id=${event.source?.msg_id} | status=error | error=${err.message}`);
      failed++;
    }
  }

  logLine(`NOTION_PUSH_END | pushed=${pushed} | failed=${failed}`);
  if (!dryRun && pushed > 0) {
    console.log(`\n${pushed} item(s) added to Notion.`);
    console.log(`Open: ${DB_URL}`);
  }
}

// --- SYNC ---
async function cmdSync(token) {
  console.log('Syncing local index with Notion DB...\n');
  const index = loadIndex();
  const pages = await queryAllPages(token, null);

  const notionIds = new Set(pages.map(p => p.id));
  const indexedIds = new Set(Object.values(index).map(e => e.page_id));

  // Pages in Notion but not in local index (pushed outside this tool or index was cleared)
  const orphanedInNotion = pages.filter(p => !indexedIds.has(p.id));
  // Entries in local index but page no longer in Notion (manually deleted)
  const missingInNotion = Object.entries(index).filter(([, v]) => !notionIds.has(v.page_id));

  console.log(`Notion DB total pages: ${pages.length}`);
  console.log(`Local index entries:   ${Object.keys(index).length}`);

  if (orphanedInNotion.length > 0) {
    console.log(`\nIn Notion but NOT in local index (${orphanedInNotion.length}):`);
    for (const p of orphanedInNotion) {
      const title = p.properties['Event Title']?.title?.[0]?.plain_text || '(untitled)';
      const status = p.properties['Status']?.select?.name || '?';
      console.log(`  - ${title} | Status: ${status} | page_id: ${p.id}`);
    }
  } else {
    console.log('\nAll Notion pages are tracked in local index. ✓');
  }

  if (missingInNotion.length > 0) {
    console.log(`\nIn local index but NOT in Notion (${missingInNotion.length}) — likely manually deleted:`);
    for (const [key, val] of missingInNotion) {
      console.log(`  - ${val.title} | key: ${key}`);
    }
    if (!dryRun) {
      for (const [key] of missingInNotion) delete index[key];
      saveIndex(index);
      console.log('Removed stale index entries.');
      logLine(`NOTION_SYNC | removed_stale=${missingInNotion.length}`);
    }
  } else {
    console.log('No stale index entries. ✓');
  }

  // Add orphaned Notion pages to local index
  if (orphanedInNotion.length > 0 && !dryRun) {
    for (const p of orphanedInNotion) {
      const title = p.properties['Event Title']?.title?.[0]?.plain_text || '(untitled)';
      const msgId = p.properties['Gmail Msg ID']?.rich_text?.[0]?.plain_text || 'unknown';
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const key = `${msgId}:${slug}`;
      index[key] = { page_id: p.id, title, msg_id: msgId, pushed_at: p.created_time };
    }
    saveIndex(index);
    console.log(`\nAdded ${orphanedInNotion.length} orphaned page(s) to local index.`);
    logLine(`NOTION_SYNC | adopted_orphans=${orphanedInNotion.length}`);
  }
}

// --- CLEAN ---
async function cmdClean(token) {
  const filterLabel = statusFilter ? `Status = ${statusFilter}` : 'all items';
  console.log(`Cleaning Notion DB (${filterLabel})${dryRun ? ' [DRY RUN]' : ''}...\n`);

  const pages = await queryAllPages(token, statusFilter);
  if (pages.length === 0) {
    console.log('No matching pages found in Notion DB.');
    return;
  }

  const index = loadIndex();
  let archived = 0, failed = 0;

  for (const page of pages) {
    const title = page.properties['Event Title']?.title?.[0]?.plain_text || '(untitled)';
    const status = page.properties['Status']?.select?.name || '?';

    if (dryRun) {
      console.log(`  [DRY RUN] Would archive: ${title} | Status: ${status}`);
      archived++;
      continue;
    }

    try {
      await notionRequest('PATCH', `/pages/${page.id}`, token, { archived: true });
      // Remove from local index
      const entry = Object.entries(index).find(([, v]) => v.page_id === page.id);
      if (entry) delete index[entry[0]];
      logLine(`NOTION_CLEAN | title=${title.slice(0, 50)} | page_id=${page.id} | status=archived`);
      archived++;
    } catch (err) {
      logLine(`NOTION_CLEAN | title=${title.slice(0, 50)} | page_id=${page.id} | status=error | error=${err.message}`);
      failed++;
    }
  }

  if (!dryRun) {
    saveIndex(index);
    logLine(`NOTION_CLEAN_END | archived=${archived} | failed=${failed}`);
  }
  console.log(`\n${archived} page(s) archived${failed > 0 ? `, ${failed} failed` : ''}.`);
}

// --- Entry point ---
async function main() {
  const env = loadEnv();
  const token = env.NOTION_TOKEN || process.env.NOTION_TOKEN;
  if (!token) { console.error('NOTION_TOKEN not found in .env'); process.exit(1); }

  if (doSync)       await cmdSync(token);
  else if (doClean) await cmdClean(token);
  else              await cmdPush(token);
}

main().catch(err => {
  console.error('Tool 2b failed:', err.message);
  process.exit(1);
});
