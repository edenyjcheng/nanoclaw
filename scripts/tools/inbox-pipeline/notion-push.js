#!/usr/bin/env node
/**
 * Tool 2b — gmail-notion-push.js
 * Push extracted events from gmail-events-pending.json → Notion Gmail Inbox Items DB.
 * Tracks pushed items locally to avoid duplicates.
 *
 * Usage:
 *   node scripts/tools/inbox-pipeline/notion-push.js [--dry-run] [--limit N]
 *   node scripts/tools/inbox-pipeline/notion-push.js --repush <msg_id>
 *   node scripts/tools/inbox-pipeline/notion-push.js --sync
 *   node scripts/tools/inbox-pipeline/notion-push.js --clean [--status <Pending|Approved|...>] [--dry-run]
 *
 * Commands:
 *   (default)        Push pending events; skip items already in archive or notion-index
 *   --repush <id>    Force re-push a specific event by Gmail Msg ID (from archive or pending)
 *   --sync           Query Notion DB, reconcile with local index, report orphans
 *   --clean          Archive Added pages older than 7 days + clear their index entries
 *
 * Options:
 *   --dry-run   Show what would happen, no API calls or file writes
 *   --limit N   Only push the first N new items
 *   --status S  Filter by Status for --clean (e.g. Pending, Approved)
 *
 * Files:
 *   events-pending.json   → events waiting to be pushed (failed items stay here for retry)
 *   events-archived.json  → events successfully pushed (source of truth for dedup)
 *   notion-index.json     → msg_id:slug → { page_id, title, msg_id, pushed_at, status } mapping
 *                           status: pushed | ignored | approved | added | not_pushed
 * Logs: groups/telegram_main/logs/gmail-scan.log
 *       NOTION_PUSH / NOTION_PUSH_END / NOTION_REPUSH / NOTION_SYNC / NOTION_CLEAN /
 *       DELETED_BY_USER
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
const KEY_FILE      = path.join(MEMORY_DIR, '.address-key.md');
const PENDING_FILE  = path.join(GMAIL_DIR, 'events-pending.json');
const ARCHIVE_FILE  = path.join(GMAIL_DIR, 'events-archived.json');
const INDEX_FILE    = path.join(GMAIL_DIR, 'notion-index.json');
const SCAN_LOG      = path.join(LOGS_DIR, 'gmail-scan.log');

const DB_ID          = '32b7c3af-c311-813f-8dae-f8516b39294f';
const DB_URL         = 'https://www.notion.so/32b7c3afc311813f8daef8516b39294f';
const NOTION_VERSION = '2022-06-28';

// --- CLI args ---
const args        = process.argv.slice(2);
const dryRun      = args.includes('--dry-run');
const doSync      = args.includes('--sync');
const doClean     = args.includes('--clean');
const limitArg    = args.indexOf('--limit');
const limit       = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : null;
const statusArg   = args.indexOf('--status');
const statusFilter = statusArg !== -1 ? args[statusArg + 1] : null;
const repushArg   = args.indexOf('--repush');
const repushMsgId = repushArg !== -1 ? args[repushArg + 1] : null;

// --- Notion token (decrypt from .address-key.md) ---
function loadNotionToken(keyFilePath) {
  const content = fs.readFileSync(keyFilePath, 'utf8');
  // Scope to the Notion section only — avoids picking up other keys in the file
  const sectionMatch = content.match(/# Notion API Token[\s\S]*?(?=\n#|$)/i);
  if (!sectionMatch) throw new Error('Notion API Token section not found in .address-key.md');
  const section = sectionMatch[0];
  const enc = section.match(/ENCRYPTED:\s*([a-f0-9]+)/)?.[1];
  const key = section.match(/KEY:\s*([a-f0-9]{64})/)?.[1];
  const iv  = section.match(/IV:\s*([a-f0-9]{32})/)?.[1];
  if (!enc || !key || !iv) throw new Error('Notion token fields (ENCRYPTED/KEY/IV) missing in .address-key.md');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
  let dec = decipher.update(enc, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
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

// --- Archive helpers (events-archived.json) ---
function loadArchive() {
  if (!fs.existsSync(ARCHIVE_FILE)) return [];
  return JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
}

function saveArchive(archive) {
  if (!dryRun) fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive, null, 2), 'utf8');
}

function archivedMsgIds(archive) {
  return new Set(archive.map(e => e.source?.msg_id).filter(Boolean));
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

// --- Push one event to Notion, update index ---
async function pushEvent(event, token, index) {
  const key = makeIndexKey(event);
  const label = event.title?.slice(0, 50);

  if (dryRun) {
    console.log(`  [DRY RUN] Would push: ${event.title} (${event.source?.account})`);
    console.log(`    Date: ${event.date || 'unknown'} | Type: ${event.type || 'Event'}`);
    return { ok: true };
  }

  try {
    const pageId = await notionRequest('POST', '/pages', token, {
      parent: { database_id: DB_ID },
      properties: buildProperties(event),
    }).then(d => d.id);

    index[key] = { page_id: pageId, title: event.title, msg_id: event.source?.msg_id, pushed_at: new Date().toISOString(), status: 'pushed' };
    saveIndex(index);
    logLine(`NOTION_PUSH | title=${label} | msg_id=${event.source?.msg_id} | page_id=${pageId} | status=ok`);
    return { ok: true, pageId };
  } catch (err) {
    logLine(`NOTION_PUSH | title=${label} | msg_id=${event.source?.msg_id} | status=error | error=${err.message}`);
    return { ok: false, error: err.message };
  }
}

// --- PUSH (default command) ---
async function cmdPush(token) {
  if (!fs.existsSync(PENDING_FILE)) {
    console.error(`No pending events file: ${PENDING_FILE}\nRun gmail-scanner.js first.`);
    process.exit(1);
  }

  let events = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  const index = loadIndex();
  const archive = loadArchive();
  const archivedIds = archivedMsgIds(archive);

  // Skip events already in archive (pushed before) or notion-index
  const newEvents = events.filter(e => {
    if (archivedIds.has(e.source?.msg_id)) return false;
    if (index[makeIndexKey(e)]) return false;
    return true;
  });
  const skipped = events.length - newEvents.length;
  if (skipped > 0) console.log(`Skipping ${skipped} already-pushed item(s).`);

  const toProcess = limit ? newEvents.slice(0, limit) : newEvents;
  if (toProcess.length === 0) {
    console.log('No new events to push — all already in archive or Notion.');
    return;
  }

  if (dryRun) console.log('[DRY RUN] No Notion API calls or file writes.\n');
  logLine(`NOTION_PUSH_START | new=${toProcess.length} | skipped=${skipped} | db=${DB_ID}`);

  let pushed = 0, failed = 0;
  const pushedEvents = [];

  for (const event of toProcess) {
    const result = await pushEvent(event, token, index);
    if (result.ok) {
      pushed++;
      pushedEvents.push(event);
    } else {
      failed++;
    }
  }

  // Move successfully pushed events: pending → archive
  if (!dryRun && pushedEvents.length > 0) {
    const pushedMsgIds = new Set(pushedEvents.map(e => e.source?.msg_id));
    const remaining = events.filter(e => !pushedMsgIds.has(e.source?.msg_id));
    fs.writeFileSync(PENDING_FILE, JSON.stringify(remaining, null, 2), 'utf8');

    const now = new Date().toISOString();
    for (const e of pushedEvents) archive.push({ ...e, archived_at: now });
    saveArchive(archive);
  }

  logLine(`NOTION_PUSH_END | pushed=${pushed} | failed=${failed}`);
  if (!dryRun && pushed > 0) {
    console.log(`\n${pushed} item(s) added to Notion and moved to archive.`);
    console.log(`Open: ${DB_URL}`);
  }
}

// --- REPUSH — force re-push a specific event by msg_id ---
async function cmdRepush(token) {
  const archive = loadArchive();
  const pending = fs.existsSync(PENDING_FILE)
    ? JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'))
    : [];

  const event = [...archive, ...pending].find(e => e.source?.msg_id === repushMsgId);
  if (!event) {
    console.error(`No event found with msg_id: ${repushMsgId}`);
    console.error('Check events-archived.json or events-pending.json for valid msg IDs.');
    process.exit(1);
  }

  console.log(`Re-pushing: ${event.title} (msg_id: ${repushMsgId})`);
  if (dryRun) {
    console.log('[DRY RUN] Would create new Notion page for this event.');
    return;
  }

  const index = loadIndex();
  const result = await pushEvent(event, token, index);
  if (result.ok) {
    console.log(`Done. New Notion page: ${result.pageId}`);
    logLine(`NOTION_REPUSH | msg_id=${repushMsgId} | page_id=${result.pageId} | status=ok`);
  } else {
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  }
}

// --- SYNC ---
// Notion Status → local status mapping
const NOTION_STATUS_MAP = { 'Pending': 'pushed', 'Ignored': 'ignored', 'Approved': 'approved', 'Added': 'added' };

async function cmdSync(token) {
  console.log('Syncing local index with Notion DB...\n');
  const index = loadIndex();
  const pages = await queryAllPages(token, null);

  const notionMap = new Map(pages.map(p => [p.id, p]));
  const indexedIds = new Set(Object.values(index).map(e => e.page_id));

  // Pages in Notion but not in local index (pushed outside this tool or index was cleared)
  const orphanedInNotion = pages.filter(p => !indexedIds.has(p.id));
  // Entries in local index but page no longer in Notion (manually deleted)
  const missingInNotion = Object.entries(index).filter(([, v]) => !notionMap.has(v.page_id));

  console.log(`Notion DB total pages: ${pages.length}`);
  console.log(`Local index entries:   ${Object.keys(index).length}`);

  // Update local index status to match Notion Status; sync Comment for Ignored items
  let statusUpdated = 0;
  let commentSynced = 0;
  for (const [key, entry] of Object.entries(index)) {
    const page = notionMap.get(entry.page_id);
    if (!page) continue;
    const notionStatus = page.properties['Status']?.select?.name || 'Pending';
    const localStatus = NOTION_STATUS_MAP[notionStatus] || 'pushed';
    if (entry.status !== localStatus) {
      if (dryRun) {
        console.log(`  [DRY RUN] Would update status: ${entry.title} | ${entry.status || '?'} → ${localStatus}`);
      } else {
        index[key].status = localStatus;
        logLine(`NOTION_SYNC | status_update | title=${entry.title?.slice(0, 50)} | ${entry.status || '?'} → ${localStatus}`);
      }
      statusUpdated++;
    }
    // Sync Comment field for Ignored items (Learning Agent reads these for rule proposals)
    if (localStatus === 'ignored') {
      const comment = page.properties['Comment']?.rich_text?.[0]?.plain_text || null;
      const existing = entry.comment || null;
      if (existing !== comment) {
        if (dryRun) {
          console.log(`  [DRY RUN] Would sync comment for: ${entry.title} | "${comment?.slice(0, 60)}"`);
        } else {
          index[key].comment = comment;
          if (comment) logLine(`NOTION_SYNC | comment_synced | title=${entry.title?.slice(0, 50)} | comment=${comment.slice(0, 80)}`);
        }
        commentSynced++;
      }
    }
  }
  if (statusUpdated > 0) console.log(`\nUpdated ${statusUpdated} local status(es) from Notion.`);
  else console.log('\nAll local statuses match Notion. ✓');
  if (commentSynced > 0) console.log(`Synced ${commentSynced} comment(s) from Ignored items.`);

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
    console.log(`\nIn local index but NOT in Notion (${missingInNotion.length}) — likely deleted by user:`);
    for (const [key, val] of missingInNotion) {
      console.log(`  - ${val.title} | key: ${key}`);
      logLine(`DELETED_BY_USER | title=${val.title?.slice(0, 50)} | msg_id=${val.msg_id} | page_id=${val.page_id}`);
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
      const notionStatus = p.properties['Status']?.select?.name || 'Pending';
      const localStatus = NOTION_STATUS_MAP[notionStatus] || 'pushed';
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const key = `${msgId}:${slug}`;
      index[key] = { page_id: p.id, title, msg_id: msgId, pushed_at: p.created_time, status: localStatus };
    }
    saveIndex(index);
    console.log(`\nAdded ${orphanedInNotion.length} orphaned page(s) to local index.`);
    logLine(`NOTION_SYNC | adopted_orphans=${orphanedInNotion.length}`);
  }

  if (!dryRun && statusUpdated > 0) saveIndex(index);
}

// --- CLEAN ---
async function cmdClean(token) {
  // Default: only archive pages with Notion Status=Added that are 7+ days old in the local index.
  // With --status S: archive pages matching that specific Status (no age filter).
  const filterLabel = statusFilter ? `Status = ${statusFilter}` : 'Added items older than 7 days';
  console.log(`Cleaning Notion DB (${filterLabel})${dryRun ? ' [DRY RUN]' : ''}...\n`);

  const queryStatus = statusFilter || 'Added';
  const pages = await queryAllPages(token, queryStatus);

  const index = loadIndex();

  // Default mode: apply 7-day age filter based on pushed_at in local index
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const eligiblePages = statusFilter
    ? pages
    : pages.filter(page => {
        const entry = Object.values(index).find(v => v.page_id === page.id);
        const pushedAt = new Date(entry?.pushed_at || page.created_time || 0);
        return pushedAt < cutoff;
      });

  if (eligiblePages.length === 0) {
    console.log('No matching pages found for archiving.');
    return;
  }

  let archived = 0, failed = 0;

  for (const page of eligiblePages) {
    const title = page.properties['Event Title']?.title?.[0]?.plain_text || '(untitled)';
    const status = page.properties['Status']?.select?.name || '?';

    if (dryRun) {
      console.log(`  [DRY RUN] Would archive: ${title} | Status: ${status}`);
      archived++;
      continue;
    }

    try {
      await notionRequest('PATCH', `/pages/${page.id}`, token, { archived: true });
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
  const token = process.env.NOTION_TOKEN || loadNotionToken(KEY_FILE);
  if (!token) { console.error('NOTION_TOKEN not found in env or .address-key.md'); process.exit(1); }

  if (repushMsgId)  await cmdRepush(token);
  else if (doSync)  await cmdSync(token);
  else if (doClean) await cmdClean(token);
  else              await cmdPush(token);
}

main().catch(err => {
  console.error('Tool 2b failed:', err.message);
  process.exit(1);
});
