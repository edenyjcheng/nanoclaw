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
// Handles: ISO (2026-03-25), M/D/YY (6/22/26), M/D/YYYY (6/22/2026),
//          "Month D YYYY" (March 25 2026), "Month D, YYYY", natural Date.parse strings,
//          date ranges like "6/22/26 - 8/14/26" (takes the start date)
function parseDate(dateStr) {
  if (!dateStr) return null;
  let s = String(dateStr).trim();

  // Range splitter: "6/22/26 - 8/14/26" → take start date only
  if (s.includes(' - ')) s = s.split(' - ')[0].trim();

  // M/D/YY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    let [, m, d, y] = mdy;
    if (y.length === 2) y = `20${y}`;
    const dt = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00`);
    if (!isNaN(dt.getTime())) return dt.toISOString().split('T')[0];
  }

  // Fallback: let Date.parse handle it (covers ISO, "March 25 2026", etc.)
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString().split('T')[0];
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
    let filter;
    if (Array.isArray(statusFilter)) {
      filter = { or: statusFilter.map(s => ({ property: 'Status', select: { equals: s } })) };
    } else if (statusFilter) {
      filter = { property: 'Status', select: { equals: statusFilter } };
    }
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}), ...(filter ? { filter } : {}) };
    const data = await notionRequest('POST', `/databases/${DB_ID}/query`, token, body);
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// --- Duplicate detection helpers ---

// Tokenise a title into lowercase words (strips punctuation)
function titleWords(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

// Returns true if titles are similar enough to be the same event:
//   - one contains the other (substring, case-insensitive), OR
//   - word overlap ratio > 80% relative to the larger word set
function titlesSimilar(a, b) {
  const al = (a || '').toLowerCase();
  const bl = (b || '').toLowerCase();
  if (al.includes(bl) || bl.includes(al)) return true;
  const aw = new Set(titleWords(a));
  const bw = new Set(titleWords(b));
  if (aw.size === 0 || bw.size === 0) return false;
  let overlap = 0;
  for (const w of aw) if (bw.has(w)) overlap++;
  return overlap / Math.max(aw.size, bw.size) > 0.8;
}

// Fetch all Pending + Approved rows from Notion (for dedup, run once per push session)
async function fetchActivePagesForDedup(token) {
  return queryAllPages(token, ['Pending', 'Approved']);
}

// Returns the existing Notion page if it's a duplicate of `event`, otherwise null.
// Match criteria: same Event Date start AND similar title.
function findDuplicate(event, activePages) {
  const eventDate = parseDate(event.date);
  if (!eventDate) return null; // can't match without a date

  const eventTitle = (event.title || '').trim();

  for (const page of activePages) {
    const pageDate = page.properties['Event Date']?.date?.start || null;
    if (!pageDate) continue;
    if (pageDate.slice(0, 10) !== eventDate) continue;

    const pageTitle = page.properties['Event Title']?.title?.map(t => t.plain_text).join('') || '';
    if (titlesSimilar(eventTitle, pageTitle)) return page;
  }
  return null;
}

// PATCH the existing Notion row with non-empty fields from the new event,
// but only if the existing field is currently empty.
async function mergeEvent(event, existingPage, token, index) {
  const props = existingPage.properties;
  const pageId = existingPage.id;

  const patch = {};

  const isEmpty = (richTextProp) => !richTextProp?.rich_text?.[0]?.plain_text;

  if (event.location && isEmpty(props['Location']))
    patch['Location'] = { rich_text: [{ text: { content: event.location } }] };

  if (event.time && isEmpty(props['Event Time']))
    patch['Event Time'] = { rich_text: [{ text: { content: String(event.time).slice(0, 200) } }] };

  if (event.notes && isEmpty(props['Notes']))
    patch['Notes'] = { rich_text: [{ text: { content: event.notes.slice(0, 2000) } }] };

  const existingTitle = props['Event Title']?.title?.map(t => t.plain_text).join('') || '';
  const label = event.title?.slice(0, 50);

  if (dryRun) {
    const fields = Object.keys(patch);
    console.log(`  [DRY RUN] MERGE (duplicate): ${event.title}`);
    console.log(`    → existing page ${pageId} ("${existingTitle}")`);
    console.log(`    → would fill empty fields: ${fields.length > 0 ? fields.join(', ') : 'none'}`);
    return { ok: true, merged: true };
  }

  if (Object.keys(patch).length > 0) {
    await notionRequest('PATCH', `/pages/${pageId}`, token, { properties: patch });
  }

  // Track in index so it isn't re-processed
  const key = makeIndexKey(event);
  index[key] = { page_id: pageId, title: event.title, msg_id: event.source?.msg_id, pushed_at: new Date().toISOString(), status: 'pushed' };
  saveIndex(index);

  const filled = Object.keys(patch);
  logLine(`NOTION_MERGE | title=${label} | msg_id=${event.source?.msg_id} | existing_page_id=${pageId} | filled=${filled.join(',') || 'none'}`);
  return { ok: true, merged: true };
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
  // If event.date is a range (e.g. "6/22/26 - 8/14/26"), extract end from second part
  const rawDate = String(event.date || '').trim();
  const rangeEnd = rawDate.includes(' - ') ? rawDate.split(' - ')[1]?.trim() : null;
  const endDateStr = parseDate(event.end_date) || (rangeEnd ? parseDate(rangeEnd) : null);
  if (dateStr) props['Event Date'] = { date: { start: dateStr, ...(endDateStr ? { end: endDateStr } : {}) } };
  if (event.time) props['Event Time'] = { rich_text: [{ text: { content: String(event.time).slice(0, 200) } }] };
  if (event.source?.subject) props['Email Subject'] = { rich_text: [{ text: { content: event.source.subject.slice(0, 2000) } }] };
  if (event.location) props['Location'] = { rich_text: [{ text: { content: event.location } }] };
  if (typeof event.registration_required === 'boolean')
    props['Registration Required'] = { checkbox: event.registration_required };
  if (event.registration_link) props['Registration Link'] = { url: event.registration_link };
  const rsvpDate = parseDate(event.rsvp_deadline);
  if (rsvpDate) props['RSVP Deadline'] = { date: { start: rsvpDate } };
  if (event.notes) props['Notes'] = { rich_text: [{ text: { content: event.notes.slice(0, 2000) } }] };

  props['Calendar'] = { select: { name: event.calendar || "Eden's Schedule" } };

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

  // Dedup by msg_id within batch: if multiple events share the same msg_id, keep only the first
  const seenBatchMsgIds = new Set();
  const limitedEvents = limit ? newEvents.slice(0, limit) : newEvents;
  const toProcess = limitedEvents.filter(e => {
    const mid = e.source?.msg_id;
    if (!mid) return true;
    if (seenBatchMsgIds.has(mid)) {
      logLine(`NOTION_PUSH_DEDUP | title=${(e.title || '').slice(0, 50)} | msg_id=${mid} | reason=batch_duplicate`);
      return false;
    }
    seenBatchMsgIds.add(mid);
    return true;
  });
  if (toProcess.length === 0) {
    console.log('No new events to push — all already in archive or Notion.');
    return;
  }

  if (dryRun) console.log('[DRY RUN] No Notion API calls or file writes.\n');
  logLine(`NOTION_PUSH_START | new=${toProcess.length} | skipped=${skipped} | db=${DB_ID}`);

  // Fetch active (Pending + Approved) rows once for duplicate detection
  const activePages = dryRun ? [] : await fetchActivePagesForDedup(token);

  // Build set of Gmail Msg IDs already in Notion — skip events whose email was already pushed
  const notionMsgIds = new Set(
    activePages
      .map(p => p.properties['Gmail Msg ID']?.rich_text?.[0]?.plain_text)
      .filter(Boolean)
  );

  let pushed = 0, merged = 0, failed = 0, msgIdSkipped = 0;
  const pushedEvents = [];

  for (const event of toProcess) {
    const msgId = event.source?.msg_id;
    // Skip if this Gmail Msg ID already exists in Notion (re-scan or multi-event dedup)
    if (msgId && notionMsgIds.has(msgId)) {
      logLine(`NOTION_PUSH_SKIP | title=${(event.title || '').slice(0, 50)} | msg_id=${msgId} | reason=msg_id_in_notion`);
      pushedEvents.push(event); // move to archive so it won't reappear in pending
      msgIdSkipped++;
      continue;
    }
    const duplicate = findDuplicate(event, activePages);
    if (duplicate) {
      const result = await mergeEvent(event, duplicate, token, index);
      if (result.ok) {
        merged++;
        pushedEvents.push(event); // move to archive regardless
      } else {
        failed++;
      }
      continue;
    }
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

  logLine(`NOTION_PUSH_END | pushed=${pushed} | merged=${merged} | failed=${failed} | msg_id_skipped=${msgIdSkipped}`);
  if (!dryRun && (pushed > 0 || merged > 0)) {
    if (pushed > 0) console.log(`\n${pushed} item(s) added to Notion and moved to archive.`);
    if (merged > 0) console.log(`${merged} duplicate(s) merged into existing Notion rows.`);
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
    console.log('[DRY RUN] Would create new Notion page for this event (or merge if duplicate found).');
    return;
  }

  const index = loadIndex();
  const activePages = await fetchActivePagesForDedup(token);
  const duplicate = findDuplicate(event, activePages);

  if (duplicate) {
    const result = await mergeEvent(event, duplicate, token, index);
    if (result.ok) {
      console.log(`Merged into existing page: ${duplicate.id}`);
      logLine(`NOTION_REPUSH | msg_id=${repushMsgId} | page_id=${duplicate.id} | status=merged`);
    } else {
      console.error(`Merge failed`);
      process.exit(1);
    }
    return;
  }

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
const NOTION_STATUS_MAP = { 'Pending': 'pushed', 'Ignored': 'ignored', 'Approved': 'approved', 'Added to Calendar': 'added', 'Added to Todo': 'added' };

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
  // Default mode (no --status flag):
  //   1. Any non-Pending, non-Archived row where Learned = true → soft-archive (Status="Archived")
  //   2. Added to Calendar / Added to Todo rows older than 7 days → soft-archive
  // Soft-archive = set Status="Archived" (stays in DB, hidden from views).
  // A separate monthly job hard-deletes rows where Status="Archived" and last_edited > 30 days ago.
  // With --status S: soft-archive pages matching that specific Status (no age filter, ignores Learned).
  const DEFAULT_CLEAN_STATUSES = ['Added to Calendar', 'Added to Todo'];
  const filterLabel = statusFilter
    ? `Status = ${statusFilter}`
    : 'non-Pending/non-Archived (Learned=true) + Added to Calendar / Added to Todo items older than 7 days';
  console.log(`Cleaning Notion DB (${filterLabel})${dryRun ? ' [DRY RUN]' : ''}...\n`);

  const index = loadIndex();

  let eligiblePages = [];

  if (statusFilter) {
    // Explicit --status: soft-archive all pages with that status, no other filters
    const pages = await queryAllPages(token, statusFilter);
    eligiblePages = pages;
  } else {
    // 1. Any non-Pending, non-Archived row where Learned=true
    //    Covers Ignored, Approved, Added to Calendar, Added to Todo — anything the agent reviewed
    const learnedPages = await notionRequest('POST', `/databases/${DB_ID}/query`, token, {
      page_size: 100,
      filter: {
        and: [
          { property: 'Learned', checkbox: { equals: true } },
          { property: 'Status', select: { does_not_equal: 'Pending' } },
          { property: 'Status', select: { does_not_equal: 'Archived' } },
        ],
      },
    }).then(d => d.results || []);

    // 2. Added to Calendar / Added to Todo older than 7 days (even if Learned=false)
    const addedPages = await queryAllPages(token, DEFAULT_CLEAN_STATUSES);
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oldAddedPages = addedPages.filter(page => {
      const entry = Object.values(index).find(v => v.page_id === page.id);
      const pushedAt = new Date(entry?.pushed_at || page.created_time || 0);
      return pushedAt < cutoff;
    });

    // Deduplicate by page ID (learnedPages may overlap with oldAddedPages)
    const seenIds = new Set();
    const deduped = [];
    for (const page of [...learnedPages, ...oldAddedPages]) {
      if (!seenIds.has(page.id)) {
        seenIds.add(page.id);
        deduped.push(page);
      }
    }
    eligiblePages = deduped;
    if (learnedPages.length > 0 || oldAddedPages.length > 0) {
      console.log(`  non-Pending/non-Archived (Learned): ${learnedPages.length} | Added (7d+): ${oldAddedPages.length} | total unique: ${eligiblePages.length}`);
    }
  }

  if (eligiblePages.length === 0) {
    console.log('No matching pages found for archiving.');
    return;
  }

  let archived = 0, failed = 0;

  for (const page of eligiblePages) {
    const title = page.properties['Event Title']?.title?.[0]?.plain_text || '(untitled)';
    const status = page.properties['Status']?.select?.name || '?';

    if (dryRun) {
      console.log(`  [DRY RUN] Would soft-archive: ${title} | Status: ${status} → Archived`);
      archived++;
      continue;
    }

    try {
      await notionRequest('PATCH', `/pages/${page.id}`, token, {
        properties: { Status: { select: { name: 'Archived' } } },
      });
      logLine(`NOTION_CLEAN | title=${title.slice(0, 50)} | page_id=${page.id} | status=soft-archived`);
      archived++;
    } catch (err) {
      logLine(`NOTION_CLEAN | title=${title.slice(0, 50)} | page_id=${page.id} | status=error | error=${err.message}`);
      failed++;
    }
  }

  if (!dryRun) {
    logLine(`NOTION_CLEAN_END | archived=${archived} | failed=${failed}`);
  }
  console.log(`\n${archived} page(s) soft-archived (Status=Archived)${failed > 0 ? `, ${failed} failed` : ''}.`);
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
