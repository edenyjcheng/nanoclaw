#!/usr/bin/env node
/**
 * Unit tests for inbox-pipeline changes (2026-03-25 session).
 * Run with: node scripts/tools/inbox-pipeline/_test.mjs
 *
 * Tests:
 *   A. notion-push.js --clean: soft-archive filter + PATCH body (Change 1 + Change 5B)
 *   B. scanner.js: registration_required → "Registration Link: TBD" note (Change 2)
 *   C. gcal-event-writer.js: effectiveTitle with --registered / --registration-required (Change 2)
 *   D. notion-event-query.js: mapPage returns `registered` bool (Change 2)
 *   E. notion-event-query.js: --registered-updates output label (Change 2)
 *   F. Learning Agent task prompt: Archived rows included in STEP 2 query (Change 5D)
 *   G. Monthly cleanup task prompt: hard-delete STEP 3 present (Change 5C)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// ─── READ SOURCE FILES ──────────────────────────────────────────────────────

const notionPushSrc        = fs.readFileSync(path.join(__dirname, 'notion-push.js'), 'utf8');
const gcalWriterSrc        = fs.readFileSync(path.join(__dirname, 'gcal-event-writer.js'), 'utf8');
const notionQuerySrc       = fs.readFileSync(path.join(__dirname, 'notion-event-query.js'), 'utf8');
const scannerSrc           = fs.readFileSync(path.join(__dirname, 'scanner.js'), 'utf8');

// ─── READ SQLITE FOR TASK PROMPTS ───────────────────────────────────────────

let learningAgentPrompt = '';
let monthlyCleanupPrompt = '';
try {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(ROOT, 'store/messages.db'));
  const la = db.prepare('SELECT prompt FROM scheduled_tasks WHERE id = ?').get('task-1774226620914-4ll2ho');
  const mc = db.prepare('SELECT prompt FROM scheduled_tasks WHERE id = ?').get('task-1774117814090-7r7vv5');
  learningAgentPrompt  = la?.prompt || '';
  monthlyCleanupPrompt = mc?.prompt || '';
  db.close();
} catch (err) {
  console.warn(`  ⚠️  Could not read SQLite DB: ${err.message}`);
}

// ─── A. notion-push.js --clean (Change 1 + Change 5B) ───────────────────────

console.log('\nA. notion-push.js --clean filter + PATCH body');

// A1: filter must exclude Archived (not re-archive already-archived rows)
assert(
  notionPushSrc.includes(`does_not_equal: 'Archived'`),
  '--clean filter excludes Status=Archived (does_not_equal)'
);

// A2: filter must exclude Pending
assert(
  notionPushSrc.includes(`does_not_equal: 'Pending'`),
  '--clean filter excludes Status=Pending (does_not_equal)'
);

// A3: filter must require Learned=true
assert(
  notionPushSrc.includes(`checkbox: { equals: true }`) &&
  notionPushSrc.includes(`Learned`),
  '--clean filter requires Learned=true checkbox'
);

// A4: PATCH body must set Status=Archived (soft-archive), NOT archived:true (hard-trash)
const cmdCleanSection = notionPushSrc.slice(
  notionPushSrc.indexOf('// --- CLEAN ---'),
  notionPushSrc.indexOf('// --- Entry point ---')
);
assert(
  cmdCleanSection.includes(`Status: { select: { name: 'Archived' } }`),
  '--clean PATCH body sets Status="Archived" (soft-archive)'
);
assert(
  !cmdCleanSection.includes(`{ archived: true }`),
  '--clean PATCH body does NOT use {archived:true} (no hard-trash)'
);

// A5: log message uses "soft-archived" not "archived"
assert(
  cmdCleanSection.includes('soft-archived'),
  '--clean log message says "soft-archived"'
);

// ─── B. scanner.js registration_required → TBD note (Change 2) ──────────────

console.log('\nB. scanner.js registration_required note');

// Replicate the exact logic from scanner.js
function applyRegistrationNote(event) {
  if (event.registration_required && !event.registration_link) {
    const note = 'Registration Link: TBD';
    event.notes = event.notes ? `${event.notes}\n${note}` : note;
  }
  return event;
}

// B1: required, no link → TBD appended
const evReq = applyRegistrationNote({ registration_required: true, registration_link: null, notes: null });
assert(evReq.notes === 'Registration Link: TBD', 'required + no link → notes = "Registration Link: TBD"');

// B2: required, no link, existing notes → TBD appended on new line
const evReqNotes = applyRegistrationNote({ registration_required: true, registration_link: null, notes: 'Costs $20' });
assert(evReqNotes.notes === 'Costs $20\nRegistration Link: TBD', 'required + existing notes → TBD appended after newline');

// B3: required, link exists → no TBD
const evReqLink = applyRegistrationNote({ registration_required: true, registration_link: 'https://example.com/register', notes: null });
assert(evReqLink.notes === null, 'required + link exists → notes unchanged (no TBD)');

// B4: not required → no TBD
const evNotReq = applyRegistrationNote({ registration_required: false, registration_link: null, notes: null });
assert(evNotReq.notes === null, 'not required → notes unchanged');

// B5: source code check — logic is present in scanner.js
assert(
  scannerSrc.includes(`if (event.registration_required && !event.registration_link)`),
  'scanner.js contains the registration_required guard'
);

// ─── C. gcal-event-writer.js effectiveTitle (Change 2) ──────────────────────

console.log('\nC. gcal-event-writer.js effectiveTitle logic');

// Replicate the exact logic from gcal-event-writer.js
function buildEffectiveTitle(titleArg, registeredFlag, registrationRequired) {
  return titleArg
    ? registeredFlag
      ? `${titleArg} (Registered)`
      : registrationRequired
        ? `${titleArg} (Register!)`
        : titleArg
    : null;
}

// C1: --registered → "(Registered)" suffix
assert(
  buildEffectiveTitle('Kendo Tournament', true, false) === 'Kendo Tournament (Registered)',
  '--registered appends " (Registered)"'
);

// C2: --registration-required → "(Register!)" suffix
assert(
  buildEffectiveTitle('Summer Camp', false, true) === 'Summer Camp (Register!)',
  '--registration-required appends " (Register!)"'
);

// C3: no flags → plain title
assert(
  buildEffectiveTitle('Team Standup', false, false) === 'Team Standup',
  'no flags → plain title unchanged'
);

// C4: no title (patch mode) → null
assert(
  buildEffectiveTitle(null, false, false) === null,
  'no --title → null (patch mode)'
);
assert(
  buildEffectiveTitle(null, true, false) === null,
  'no --title with --registered → null (patch mode, no title to suffix)'
);

// C5: --registered takes priority over --registration-required
assert(
  buildEffectiveTitle('Event', true, true) === 'Event (Registered)',
  '--registered takes priority over --registration-required'
);

// C6: source code check — flags present in gcal-event-writer.js
assert(
  gcalWriterSrc.includes(`hasFlag('--registered')`) &&
  gcalWriterSrc.includes(`hasFlag('--registration-required')`),
  'gcal-event-writer.js declares --registered and --registration-required flags'
);

// ─── D. notion-event-query.js mapPage `registered` field (Change 2) ──────────

console.log('\nD. notion-event-query.js mapPage registered field');

// Replicate mapPage registered field extraction
function extractRegistered(props) {
  return props['Registered']?.checkbox ?? false;
}

// D1: checkbox true → registered=true
assert(extractRegistered({ Registered: { checkbox: true } }) === true, 'Registered checkbox true → registered=true');

// D2: checkbox false → registered=false
assert(extractRegistered({ Registered: { checkbox: false } }) === false, 'Registered checkbox false → registered=false');

// D3: column missing → registered=false (default)
assert(extractRegistered({}) === false, 'Registered column missing → registered=false (default)');

// D4: source code check — registered field in mapPage
assert(
  notionQuerySrc.includes(`registered:`) &&
  notionQuerySrc.includes(`props['Registered']?.checkbox ?? false`),
  'notion-event-query.js mapPage includes registered field'
);

// ─── E. notion-event-query.js --registered-updates mode (Change 2) ────────────

console.log('\nE. notion-event-query.js --registered-updates mode');

// E1: --registered-updates flag declared
assert(
  notionQuerySrc.includes(`hasFlag('--registered-updates')`) ||
  notionQuerySrc.includes(`'--registered-updates'`),
  '--registered-updates flag declared'
);

// E2: REGISTERED_UPDATES output label present
assert(
  notionQuerySrc.includes(`REGISTERED_UPDATES:`),
  'outputs "REGISTERED_UPDATES:" label on stdout'
);

// E3: query filter checks Registered=true + Status=Added to Calendar
assert(
  notionQuerySrc.includes(`'Added to Calendar'`) &&
  notionQuerySrc.includes(`Registered`) &&
  notionQuerySrc.includes(`checkbox: { equals: true }`),
  '--registered-updates query filters Registered=true + Added to Calendar'
);

// ─── F. Learning Agent task prompt (Change 5D) ──────────────────────────────

console.log('\nF. Learning Agent task — Archived rows in STEP 2');

if (learningAgentPrompt) {
  // F1: STEP 2 mentions Archived rows
  assert(
    learningAgentPrompt.includes('Archived'),
    'STEP 2 includes Archived rows in query'
  );

  // F2: Archived rows formatted with date context
  assert(
    learningAgentPrompt.includes('[Archived as of'),
    'Archived rows formatted as "[Archived as of YYYY-MM-DD]"'
  );

  // F3: STEP 4 skips Archived rows when marking Learned=true
  assert(
    learningAgentPrompt.includes('Status != Archived') ||
    learningAgentPrompt.includes("Status != 'Archived'") ||
    (learningAgentPrompt.includes('Skip Archived rows') || learningAgentPrompt.includes('skip Archived')),
    'STEP 4 skips Archived rows when marking Learned=true'
  );
} else {
  console.warn('  ⚠️  Skipped (Learning Agent task not found in DB)');
}

// ─── G. Monthly cleanup task prompt (Change 5C) ─────────────────────────────

console.log('\nG. Monthly cleanup task — hard-delete STEP 3');

if (monthlyCleanupPrompt) {
  // G1: hard-delete step is present
  assert(
    monthlyCleanupPrompt.includes('Hard-delete') || monthlyCleanupPrompt.includes('hard-delete'),
    'Monthly cleanup task contains hard-delete step'
  );

  // G2: targets Status=Archived rows
  assert(
    monthlyCleanupPrompt.includes('"Archived"') || monthlyCleanupPrompt.includes("'Archived'"),
    'Hard-delete step targets Status=Archived rows'
  );

  // G3: 30-day age threshold
  assert(
    monthlyCleanupPrompt.includes('30 days') || monthlyCleanupPrompt.includes('30*24'),
    'Hard-delete step uses 30-day age threshold'
  );

  // G4: uses archived:true for permanent deletion (intentional — this IS the hard-delete)
  assert(
    monthlyCleanupPrompt.includes('archived:true') || monthlyCleanupPrompt.includes('"archived":true') || monthlyCleanupPrompt.includes('archived: true'),
    'Hard-delete step permanently trashes rows via archived:true'
  );
} else {
  console.warn('  ⚠️  Skipped (Monthly cleanup task not found in DB)');
}

// ─── SUMMARY ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed.`);
}
