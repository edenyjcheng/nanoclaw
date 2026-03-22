#!/usr/bin/env node
/**
 * Tool 2 — gmail-scanner.js
 * Scans Gmail accounts for event-related emails and extracts event candidates.
 *
 * Usage:
 *   node scripts/gmail-scanner.js [--account <name>] [--dry-run]
 *
 * Options:
 *   --account <name>   Scan only this account (default: all enabled accounts)
 *   --dry-run          Show what would be extracted without writing files
 *
 * Output:
 *   groups/telegram_main/memory/gmail-events-pending.json   extracted events
 *   groups/telegram_main/logs/gmail-scan.log                scan activity log
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { google } from 'googleapis';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';

const OLLAMA_URL_DEFAULT = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
const OLLAMA_MODEL_DEFAULT = 'gemma3:4b';

function loadClaudeApiKey() {
  try {
    const configPath = path.join(os.homedir(), '.claude', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.primaryApiKey || null;
  } catch {
    return null;
  }
}
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const MEMORY_DIR = path.join(GROUP_DIR, 'memory');
const LOGS_DIR = path.join(GROUP_DIR, 'logs');
const KEY_FILE = path.join(MEMORY_DIR, '.address-key.md');
const CONFIG_FILE = path.join(MEMORY_DIR, 'gmail-config.json');
const PENDING_FILE = path.join(MEMORY_DIR, 'gmail-events-pending.json');
const SCAN_LOG = path.join(LOGS_DIR, 'gmail-scan.log');
const GUIDE_FILE = path.join(MEMORY_DIR, 'gmail-scanner-guide.md');

// --- CLI args ---
const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const hasFlag = (flag) => args.includes(flag);

const filterAccount = getArg('--account');
const dryRun = hasFlag('--dry-run');

// --- Encryption helpers ---
function loadEncryptionKey() {
  const content = fs.readFileSync(KEY_FILE, 'utf8');
  const match = content.match(/KEY:\s*([a-f0-9]{64})/m);
  if (!match) throw new Error('No valid KEY found in .address-key.md');
  return Buffer.from(match[1], 'hex');
}

function decrypt(ciphertext, key) {
  const { iv, data } = JSON.parse(ciphertext);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
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

// --- Scanner guide loader ---
function loadGuide() {
  if (!fs.existsSync(GUIDE_FILE)) return { skipFrom: [], skipSubjectPatterns: [], onlyFrom: [], extractionGuidelines: '' };

  const text = fs.readFileSync(GUIDE_FILE, 'utf8');

  // Parse a bullet list section: lines starting with "- " (not commented out with "# -")
  function parseList(sectionHeader) {
    const sectionMatch = text.match(new RegExp(`### ${sectionHeader}\\n([\\s\\S]*?)(?=\\n###|\\n---|$)`));
    if (!sectionMatch) return [];
    return sectionMatch[1]
      .split('\n')
      .filter(l => l.match(/^- .+/))         // active bullets only (not "# -")
      .map(l => l.replace(/^- /, '').trim())
      .filter(Boolean);
  }

  // Parse the extraction guidelines block (everything under ## EXTRACTION GUIDELINES)
  const guideMatch = text.match(/## EXTRACTION GUIDELINES([\s\S]*?)(?=\n## |$)/);
  const extractionGuidelines = guideMatch
    ? guideMatch[1].trim()
    : '';

  // Parse key: value settings (active lines only, not commented with #)
  function parseSetting(key) {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  }

  return {
    skipFrom: parseList('Skip Sender').map(e => e.toLowerCase()),
    skipSubjectPatterns: parseList('Skip Subject Patterns').map(p => new RegExp(p, 'i')),
    onlyFrom: parseList('Only Sender').map(e => e.toLowerCase()),
    extractionGuidelines,
    ollamaUrl: parseSetting('ollama_url') || OLLAMA_URL_DEFAULT,
    ollamaModel: parseSetting('ollama_model') || OLLAMA_MODEL_DEFAULT,
  };
}

// --- Apply guide filters to an email ---
function applyGuideFilters(guide, from, subject) {
  const fromLower = from.toLowerCase();

  // onlyFrom whitelist (if set)
  if (guide.onlyFrom.length > 0) {
    const allowed = guide.onlyFrom.some(addr => fromLower.includes(addr));
    if (!allowed) return { skip: true, reason: `not in onlyFrom whitelist` };
  }

  // skipFrom
  for (const addr of guide.skipFrom) {
    if (fromLower.includes(addr)) return { skip: true, reason: `from address matches skipFrom: ${addr}` };
  }

  // skipSubjectPatterns
  for (const pattern of guide.skipSubjectPatterns) {
    if (pattern.test(subject)) return { skip: true, reason: `subject matches pattern: ${pattern}` };
  }

  return { skip: false };
}

// --- Scan log (skip already-scanned message IDs) ---
function loadScannedIds() {
  if (!fs.existsSync(SCAN_LOG)) return new Set();
  const content = fs.readFileSync(SCAN_LOG, 'utf8');
  const ids = new Set();
  for (const line of content.split('\n')) {
    const match = line.match(/msg_id=([^\s|]+)/);
    if (match) ids.add(match[1]);
  }
  return ids;
}

// --- Gmail date filter ---
function buildQuery(scan, keywords) {
  let dateFilter = '';
  if (scan.mode === 'interval') {
    const cutoff = new Date(Date.now() - scan.interval_hours * 60 * 60 * 1000);
    // Gmail uses epoch seconds for after: filter
    dateFilter = `after:${Math.floor(cutoff.getTime() / 1000)}`;
  } else if (scan.mode === 'date_range' && scan.date_from) {
    const from = scan.date_from.replace(/-/g, '/');
    const to = scan.date_to ? scan.date_to.replace(/-/g, '/') : '';
    dateFilter = `after:${from}${to ? ` before:${to}` : ''}`;
  }
  const keywordQuery = keywords.map(k => `"${k}"`).join(' OR ');
  return `${dateFilter} (${keywordQuery})`.trim();
}

// --- Shared prompt builder ---
function buildExtractionPrompt(emailSubject, emailBody, emailFrom, guideLines) {
  const guideSection = guideLines
    ? `\nScanner guidelines (follow these rules when extracting):\n${guideLines}\n`
    : '';

  return `You are an event extraction assistant. Analyze this email and extract any events, meetings, appointments, deadlines, or calendar-worthy items.
${guideSection}
Email from: ${emailFrom}
Subject: ${emailSubject}
Body:
${emailBody.slice(0, 3000)}

Extract all events found. For each event return a JSON object with these fields:
- title: string (event name, inferred from context)
- date: string (ISO date if parseable, or natural language like "March 25, 2026")
- time: string or null (e.g. "10:00 AM", "3pm", null if not found)
- location: string or null (physical address or virtual URL)
- registration_required: boolean
- registration_link: string or null
- rsvp_deadline: string or null
- notes: string or null (any other relevant details)

If no events found, return an empty array.
Respond with ONLY a valid JSON array, no explanation.`;
}

function parseJsonResponse(text) {
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const match = clean.match(/\[[\s\S]*\]/);
  return match ? JSON.parse(match[0]) : JSON.parse(clean);
}

// --- Ollama extraction ---
async function extractWithOllama(prompt, ollamaUrl, ollamaModel) {
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return parseJsonResponse(data.message?.content?.trim() || '');
}

// --- Claude fallback extraction ---
async function extractWithClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY || loadClaudeApiKey();
  if (!apiKey) throw new Error('No Claude API key found in ANTHROPIC_API_KEY or ~/.claude/config.json');
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  return parseJsonResponse(response.content[0].text.trim());
}

// --- Event extraction with Ollama-first, Claude fallback ---
async function extractEvents(emailSubject, emailBody, emailFrom, guide) {
  const prompt = buildExtractionPrompt(emailSubject, emailBody, emailFrom, guide.extractionGuidelines);
  try {
    const result = await extractWithOllama(prompt, guide.ollamaUrl, guide.ollamaModel);
    return result;
  } catch (ollamaErr) {
    logLine(`FALLBACK | reason=ollama_failed | error=${ollamaErr.message} | using=claude-haiku`);
    try {
      const result = await extractWithClaude(prompt);
      return result;
    } catch (claudeErr) {
      logLine(`FALLBACK_FAILED | error=${claudeErr.message}`);
      return [];
    }
  }
}

// --- Decode email body ---
function decodeBody(payload) {
  const parts = payload.parts || [payload];
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf8');
    }
  }
  // fallback: try HTML parts
  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      const html = Buffer.from(part.body.data, 'base64').toString('utf8');
      // Strip HTML tags for plain text
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    // Recurse into nested parts
    if (part.parts) {
      const nested = decodeBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

// --- Process one account ---
async function scanAccount(account, key, scannedIds, dryRun, guide) {
  const credsEncrypted = fs.readFileSync(path.join(MEMORY_DIR, account.credentials_file), 'utf8');
  const tokenEncrypted = fs.readFileSync(path.join(MEMORY_DIR, account.token_file), 'utf8');

  const creds = JSON.parse(decrypt(credsEncrypted, key));
  const tokens = JSON.parse(decrypt(tokenEncrypted, key));

  const { client_id, client_secret } = creds.installed || creds.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3000/oauth2callback');
  oAuth2Client.setCredentials(tokens);

  // Auto-save refreshed tokens
  oAuth2Client.on('tokens', (newTokens) => {
    if (!dryRun && newTokens.refresh_token) {
      const merged = { ...tokens, ...newTokens };
      // Re-encrypt and save
      const iv = crypto.randomBytes(16);
      const encKey = loadEncryptionKey();
      const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(merged), 'utf8'), cipher.final()]);
      fs.writeFileSync(
        path.join(MEMORY_DIR, account.token_file),
        JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex') }),
        'utf8'
      );
    }
  });

  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const query = buildQuery(account.scan, config.keywords);

  logLine(`SCAN_START | account=${account.name} | mode=${account.scan.mode} | query="${query}"`);

  // Fetch matching message IDs
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 50,
  });

  const messages = listRes.data.messages || [];
  logLine(`SCAN_FOUND | account=${account.name} | count=${messages.length}`);

  const extractedEvents = [];
  let skipped = 0;
  let extracted = 0;

  for (const msg of messages) {
    const msgId = msg.id;

    if (scannedIds.has(msgId)) {
      skipped++;
      logLine(`MSG | account=${account.name} | msg_id=${msgId} | action=skipped`);
      continue;
    }

    // Fetch full message
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msgId,
      format: 'full',
    });

    const headers = full.data.payload.headers || [];
    const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
    const from = headers.find(h => h.name === 'From')?.value || '';
    const body = decodeBody(full.data.payload);

    // Apply guide filters
    const filterResult = applyGuideFilters(guide, from, subject);
    if (filterResult.skip) {
      skipped++;
      logLine(`MSG | account=${account.name} | msg_id=${msgId} | subject=${subject.slice(0, 60)} | action=skipped_by_guide | reason=${filterResult.reason}`);
      scannedIds.add(msgId);
      continue;
    }

    logLine(`MSG | account=${account.name} | msg_id=${msgId} | subject=${subject.slice(0, 60)} | action=processing`);

    const events = await extractEvents(subject, body, from, guide);

    if (events.length > 0) {
      extracted++;
      for (const event of events) {
        extractedEvents.push({
          ...event,
          source: {
            account: account.name,
            email: account.email,
            msg_id: msgId,
            subject,
            from,
          },
        });
      }
      logLine(`MSG | account=${account.name} | msg_id=${msgId} | subject=${subject.slice(0, 60)} | action=extracted | events=${events.length}`);
    } else {
      logLine(`MSG | account=${account.name} | msg_id=${msgId} | subject=${subject.slice(0, 60)} | action=no_events`);
    }

    scannedIds.add(msgId);
  }

  logLine(`SCAN_END | account=${account.name} | extracted=${extracted} | skipped=${skipped} | total=${messages.length}`);
  return extractedEvents;
}

// --- Format review output ---
function formatReview(events) {
  if (events.length === 0) {
    return 'Gmail Scan Complete — no new events found.';
  }

  const lines = [`Gmail Scan Complete — ${events.length} potential event(s) found\n`];
  events.forEach((e, i) => {
    lines.push(`[${i + 1}] ${e.title}`);
    lines.push(`    Date: ${e.date}${e.time ? ' @ ' + e.time : ''}`);
    if (e.location) lines.push(`    Location: ${e.location}`);
    lines.push(`    Register: ${e.registration_required ? 'Yes' + (e.rsvp_deadline ? ' — deadline ' + e.rsvp_deadline : '') : 'No'}`);
    if (e.registration_link) lines.push(`    Link: ${e.registration_link}`);
    lines.push(`    Source: ${e.source.account} — from ${e.source.from}`);
    lines.push('');
  });
  lines.push('Reply: "add 1,3" / "add all" / "skip all" / "ignore 2"');
  return lines.join('\n');
}

// --- Main ---
async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const key = loadEncryptionKey();
  const scannedIds = loadScannedIds();

  let accounts = config.accounts.filter(a => a.enabled);
  if (filterAccount) {
    accounts = accounts.filter(a => a.name.toLowerCase() === filterAccount.toLowerCase());
    if (accounts.length === 0) {
      console.error(`No enabled account found with name: ${filterAccount}`);
      process.exit(1);
    }
  }

  const guide = loadGuide();
  logLine(`GUIDE_LOADED | skipFrom=${guide.skipFrom.length} | skipPatterns=${guide.skipSubjectPatterns.length} | onlyFrom=${guide.onlyFrom.length} | ollama=${guide.ollamaUrl} | model=${guide.ollamaModel}`);

  if (dryRun) console.log('[DRY RUN] No files will be written.\n');

  const allEvents = [];
  for (const account of accounts) {
    const events = await scanAccount(account, key, scannedIds, dryRun, guide);
    allEvents.push(...events);
  }

  // Write pending events
  if (!dryRun) {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(allEvents, null, 2), 'utf8');
    console.log(`\nPending events saved: ${PENDING_FILE}`);
  }

  // Print review format
  console.log('\n' + '='.repeat(50));
  console.log(formatReview(allEvents));
  console.log('='.repeat(50));

  return allEvents;
}

main().catch(err => {
  console.error('\nScanner failed:', err.message);
  process.exit(1);
});
