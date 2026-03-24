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
const GMAIL_DIR = path.join(MEMORY_DIR, 'tools', 'inbox-pipeline');
const LOGS_DIR = path.join(GROUP_DIR, 'logs');
const KEY_FILE = path.join(MEMORY_DIR, '.address-key.md');
const CONFIG_FILE = path.join(GMAIL_DIR, 'config.json');
const PENDING_FILE = path.join(GMAIL_DIR, 'events-pending.json');
const ALERTS_FILE  = path.join(GMAIL_DIR, 'alerts-pending.json');
const SCAN_LOG = path.join(LOGS_DIR, 'gmail-scan.log');
const GUIDE_FILE = path.join(GMAIL_DIR, 'scanner-guide.md');

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

  // Parse ## CALENDAR DEFAULTS blocks (From Sender + Subject Contains)
  function parseCalendarDefaults() {
    const section = text.match(/## CALENDAR DEFAULTS([\s\S]*?)(?=\n## |$)/);
    if (!section) return { fromSender: [], subjectContains: [] };

    function parseRules(header) {
      const block = section[1].match(new RegExp(`### ${header}\\n([\\s\\S]*?)(?=\\n###|$)`));
      if (!block) return [];
      return block[1]
        .split('\n')
        .filter(l => /^- .+→.+/.test(l))
        .map(l => {
          const parts = l.replace(/^- /, '').split('→').map(s => s.trim());
          return parts.length === 2 ? { pattern: parts[0], calendar: parts[1] } : null;
        })
        .filter(Boolean);
    }

    return {
      fromSender: parseRules('From Sender'),
      subjectContains: parseRules('Subject Contains'),
    };
  }

  // Parse ## ALERT CATEGORIES blocks
  function parseAlertCategories() {
    const section = text.match(/## ALERT CATEGORIES([\s\S]*?)(?=\n## |$)/);
    if (!section) return [];
    const cats = [];
    const blocks = [...section[1].matchAll(/### Alert: (.+?)\n([\s\S]*?)(?=\n### Alert:|$)/g)];
    for (const b of blocks) {
      const name = b[1].trim();
      const body = b[2];
      const emoji = body.match(/Emoji:\s*(\S+)/)?.[1] || '🔔';
      const kwMatch = body.match(/Match keywords[^\n]*\n([\s\S]*?)(?=\nSummary:|Note:|$)/);
      const keywords = kwMatch
        ? kwMatch[1].split(',').map(k => k.trim()).filter(k => k.length > 0)
        : [];
      cats.push({ name, emoji, keywords });
    }
    return cats;
  }

  return {
    skipFrom: parseList('Skip Sender').map(e => e.toLowerCase()),
    skipSubjectPatterns: parseList('Skip Subject Patterns').map(p => new RegExp(p, 'i')),
    onlyFrom: parseList('Only Sender').map(e => e.toLowerCase()),
    skipCategories: parseList('Skip Gmail Categories').map(c => c.toLowerCase()),
    extractionGuidelines,
    alertCategories: parseAlertCategories(),
    calendarDefaults: parseCalendarDefaults(),
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

// --- Build query with guide categories ---
function buildQueryWithGuide(scan, keywords, guide) {
  const base = buildQuery(scan, keywords);
  if (!guide.skipCategories || guide.skipCategories.length === 0) return base;
  const categoryFilter = guide.skipCategories.map(c => `-category:${c}`).join(' ');
  return `${base} ${categoryFilter}`.trim();
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
- date: string (start date in YYYY-MM-DD format if parseable, or natural language like "March 25, 2026")
- end_date: string or null (end date in YYYY-MM-DD for multi-day events, null for single-day or unknown)
- time: string or null (time of day as a string, e.g. "10:00am - 4:00pm", null if not found)
- location: string or null (physical address or virtual URL)
- registration_required: boolean
- registration_link: string or null
- rsvp_deadline: string or null
- notes: string or null (include full context: description, pricing, organizer, who sent it, any other relevant details)
- confidence: number (0.0–1.0 — how confident you are this is a real calendar-worthy event; use < 0.7 for ambiguous or promotional emails)

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

// --- Alert summary generation (Ollama, falls back to subject line) ---
async function generateAlertSummary(categoryName, subject, body, guide) {
  const prompt = `Summarize this email in exactly 1 sentence for the "${categoryName}" alert category.

Subject: ${subject}
Body:
${body.slice(0, 2000)}

Respond with ONE sentence only. No explanation.`;
  try {
    const res = await fetch(`${guide.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: guide.ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return data.message?.content?.trim() || subject;
  } catch {
    return subject;
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
  const credsEncrypted = fs.readFileSync(path.join(GMAIL_DIR, account.credentials_file), 'utf8');
  const tokenEncrypted = fs.readFileSync(path.join(GMAIL_DIR, account.token_file), 'utf8');

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
        path.join(GMAIL_DIR, account.token_file),
        JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex') }),
        'utf8'
      );
    }
  });

  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const query = buildQueryWithGuide(account.scan, config.keywords, guide);

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
  const alertsFound = [];
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

    // Alert detection (runs alongside event extraction; same email can be both)
    const emailAlerts = [];
    if (guide.alertCategories.length > 0) {
      const searchText = (subject + ' ' + body).toLowerCase();
      for (const cat of guide.alertCategories) {
        if (cat.keywords.some(k => searchText.includes(k.toLowerCase()))) {
          const summary = await generateAlertSummary(cat.name, subject, body, guide);
          emailAlerts.push({ category: cat.name, emoji: cat.emoji, summary, msg_id: msgId, subject, from, account: account.name });
          logLine(`ALERT | account=${account.name} | msg_id=${msgId} | category=${cat.name} | summary=${summary.slice(0, 80)}`);
        }
      }
    }

    const events = await extractEvents(subject, body, from, guide);
    const source = { account: account.name, email: account.email, msg_id: msgId, subject, from };

    if (events.length > 0) {
      extracted++;
      for (const event of events) {
        // Confidence flag: prepend warning to Notes if model confidence < 0.7
        const confidence = typeof event.confidence === 'number' ? event.confidence : 1.0;
        if (confidence < 0.7) {
          const warning = '⚠️ Low confidence — please verify';
          event.notes = event.notes ? `${warning}\n${event.notes}` : warning;
          logLine(`MSG | account=${account.name} | msg_id=${msgId} | confidence=${confidence.toFixed(2)} | action=low_confidence`);
        }

        // Calendar defaults: apply guide rules if model didn't assign a calendar
        if (!event.calendar) {
          const fromLower = from.toLowerCase();
          const subjectLower = subject.toLowerCase();
          for (const rule of (guide.calendarDefaults?.fromSender || [])) {
            if (fromLower.includes(rule.pattern.toLowerCase())) {
              event.calendar = rule.calendar;
              break;
            }
          }
          if (!event.calendar) {
            for (const rule of (guide.calendarDefaults?.subjectContains || [])) {
              if (subjectLower.includes(rule.pattern.toLowerCase())) {
                event.calendar = rule.calendar;
                break;
              }
            }
          }
        }

        extractedEvents.push({ ...event, source });
      }
      logLine(`MSG | account=${account.name} | msg_id=${msgId} | subject=${subject.slice(0, 60)} | action=extracted | events=${events.length}`);
    } else {
      logLine(`MSG | account=${account.name} | msg_id=${msgId} | subject=${subject.slice(0, 60)} | action=no_events`);
    }

    // Write alerts as events too (type=Alert) for Notion record keeping
    for (const alert of emailAlerts) {
      extractedEvents.push({
        title: `[${alert.category}] ${alert.subject.slice(0, 80)}`,
        date: null,
        type: 'Alert',
        notes: alert.summary,
        source,
      });
    }

    scannedIds.add(msgId);
    alertsFound.push(...emailAlerts);
  }

  logLine(`SCAN_END | account=${account.name} | extracted=${extracted} | skipped=${skipped} | total=${messages.length} | alerts=${alertsFound.length}`);
  return { events: extractedEvents, alerts: alertsFound };
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
  logLine(`GUIDE_LOADED | skipFrom=${guide.skipFrom.length} | skipPatterns=${guide.skipSubjectPatterns.length} | onlyFrom=${guide.onlyFrom.length} | skipCategories=${guide.skipCategories.length} | alertCategories=${guide.alertCategories.length} | calendarDefaults=${(guide.calendarDefaults.fromSender.length + guide.calendarDefaults.subjectContains.length)} | ollama=${guide.ollamaUrl} | model=${guide.ollamaModel}`);

  if (dryRun) console.log('[DRY RUN] No files will be written.\n');

  const allEvents = [];
  const allAlerts = [];
  for (const account of accounts) {
    const { events, alerts } = await scanAccount(account, key, scannedIds, dryRun, guide);
    allEvents.push(...events);
    allAlerts.push(...alerts);
  }

  // Write pending events (includes Alert-type entries for Notion record keeping)
  if (!dryRun) {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(allEvents, null, 2), 'utf8');
    console.log(`\nPending events saved: ${PENDING_FILE}`);
  }

  // Write alerts-pending.json for the agent to send as Telegram heads-up
  if (allAlerts.length > 0) {
    if (!dryRun) {
      fs.writeFileSync(ALERTS_FILE, JSON.stringify(allAlerts, null, 2), 'utf8');
    }
    // Print structured alert block — agent reads this and sends via send_message
    console.log('\nALERTS_FOUND:');
    const lines = [`🔔 *Heads Up* — ${allAlerts.length} alert(s) from your inbox:`];
    for (const a of allAlerts) lines.push(`${a.emoji} *${a.category}* — ${a.summary}`);
    console.log(JSON.stringify({ type: 'TELEGRAM_SEND', message: lines.join('\n') }));
  } else if (!dryRun) {
    // Clear stale alerts file if no alerts this run
    if (fs.existsSync(ALERTS_FILE)) fs.writeFileSync(ALERTS_FILE, '[]', 'utf8');
  }

  // Print review format
  const reviewEvents = allEvents.filter(e => e.type !== 'Alert');
  console.log('\n' + '='.repeat(50));
  console.log(formatReview(reviewEvents));
  console.log('='.repeat(50));

  return allEvents;
}

main().catch(err => {
  console.error('\nScanner failed:', err.message);
  process.exit(1);
});
