#!/usr/bin/env node
/**
 * Restore all archived (trashed) pages in the Gmail Events DB back to unarchived.
 * Run with: node scripts/tools/inbox-pipeline/_restore-trash.mjs [--dry-run]
 */
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUP_DIR  = process.env.NANOCLAW_GROUP_DIR || 'groups/telegram_main';
const KEY_FILE   = path.join(GROUP_DIR, 'memory', '.address-key.md');
const DB_ID      = '32b7c3af-c311-813f-8dae-f8516b39294f';
const NOTION_VERSION = '2022-06-28';

const dryRun = process.argv.includes('--dry-run');

function loadNotionToken() {
  const content = fs.readFileSync(KEY_FILE, 'utf8');
  const sectionMatch = content.match(/# Notion API Token[\s\S]*?(?=\n#|$)/i);
  if (!sectionMatch) throw new Error('Notion API Token section not found');
  const section = sectionMatch[0];
  const enc = section.match(/ENCRYPTED:\s*([a-f0-9]+)/)[1];
  const key = section.match(/KEY:\s*([a-f0-9]{64})/)[1];
  const iv  = section.match(/IV:\s*([a-f0-9]{32})/)[1];
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key,'hex'), Buffer.from(iv,'hex'));
  return d.update(enc,'hex','utf8') + d.final('utf8');
}

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

async function main() {
  const token = loadNotionToken();

  console.log(`Querying archived pages in Gmail Events DB${dryRun ? ' [DRY RUN]' : ''}...\n`);

  // Paginate through all trashed pages
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100, archived: true, ...(cursor ? { start_cursor: cursor } : {}) };
    const data = await notionRequest('POST', `/databases/${DB_ID}/query`, token, body);
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  if (pages.length === 0) {
    console.log('No archived pages found in Gmail Events DB — nothing to restore.');
    return;
  }

  console.log(`Found ${pages.length} archived page(s):\n`);
  for (const p of pages) {
    const title  = p.properties['Event Title']?.title?.[0]?.plain_text || '(untitled)';
    const status = p.properties['Status']?.select?.name || '?';
    const learned = p.properties['Learned']?.checkbox ? ' [Learned]' : '';
    console.log(`  - ${title.slice(0, 60)} | Status: ${status}${learned} | id: ${p.id}`);
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would restore ${pages.length} page(s). Re-run without --dry-run to apply.`);
    return;
  }

  console.log(`\nRestoring...`);
  let restored = 0, failed = 0;
  for (const p of pages) {
    const title = p.properties['Event Title']?.title?.[0]?.plain_text || '(untitled)';
    try {
      await notionRequest('PATCH', `/pages/${p.id}`, token, { archived: false, in_trash: false });
      console.log(`  ✅ Restored: ${title.slice(0, 60)}`);
      restored++;
    } catch (err) {
      console.log(`  ❌ Failed: ${title.slice(0, 60)} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Restored: ${restored}${failed > 0 ? ` | Failed: ${failed}` : ''}`);
}

main().catch(err => {
  console.error('Restore failed:', err.message);
  process.exit(1);
});
