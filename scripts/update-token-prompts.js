'use strict';
const db = require('./node_modules/better-sqlite3')('./store/messages.db');

function logCmd(job, model) {
  return `node -e "try{const h=require('/workspace/group/memory/docs/token-usage-helper.js');h.logTokenUsage('${job}','${model}',0);}catch(e){}"`;
}

const updates = {};

// ─── morning_briefing ────────────────────────────────────────────────────────
{
  const t = db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 'task-1774307661101-nzqfxp'").get();
  let p = t.prompt;
  p = p.replace(
    'Write to /workspace/group/memory/docs/job-status.json: morning_briefing last_run = now ISO, last_status = "ok", last_model = "gemma3:4b".',
    'Write to /workspace/group/memory/docs/job-status.json: morning_briefing last_run = now ISO, last_status = "ok", last_model = "gemma3:4b", last_tokens = 0.'
  );
  p = p.replace(
    'STEP 6 — Deregister\nRemove "morning_briefing" from active_jobs in /workspace/group/memory/docs/job-tracker.json.',
    'STEP 5.5 — Log token usage\n' + logCmd('morning_briefing', 'gemma3:4b') + '\n\nSTEP 6 — Deregister\nRemove "morning_briefing" from active_jobs in /workspace/group/memory/docs/job-tracker.json.'
  );
  updates['task-1774307661101-nzqfxp'] = p;
}

// ─── tomorrow_preview ────────────────────────────────────────────────────────
{
  const t = db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 'task-1774365495441-bkjitq'").get();
  let p = t.prompt;
  p = p.replace(
    'Write to /workspace/group/memory/docs/job-status.json: tomorrow_preview last_run = now ISO, last_status = "ok", last_model = "gemma3:4b".',
    'Write to /workspace/group/memory/docs/job-status.json: tomorrow_preview last_run = now ISO, last_status = "ok", last_model = "gemma3:4b", last_tokens = 0.'
  );
  p = p.replace(
    'STEP 6 — Deregister\nRemove "tomorrow_preview" from active_jobs in /workspace/group/memory/docs/job-tracker.json.',
    'STEP 5.5 — Log token usage\n' + logCmd('tomorrow_preview', 'gemma3:4b') + '\n\nSTEP 6 — Deregister\nRemove "tomorrow_preview" from active_jobs in /workspace/group/memory/docs/job-tracker.json.'
  );
  updates['task-1774365495441-bkjitq'] = p;
}

// ─── gmail_scan_1pm ──────────────────────────────────────────────────────────
{
  const t = db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 'task-1774364980425-2ez3de'").get();
  let p = t.prompt;
  p = p.replace(
    '- last_model: "qwen3-vl:8b"\n\nSTEP 6 — Deregister\nRemove "gmail_scan_1pm" from active_jobs in /workspace/group/memory/docs/job-tracker.json.',
    '- last_model: "qwen3-vl:8b"\n- last_tokens: 0\n\nSTEP 5.5 — Log token usage\n' + logCmd('gmail_scan_1pm', 'qwen3-vl:8b') + '\n\nSTEP 6 — Deregister\nRemove "gmail_scan_1pm" from active_jobs in /workspace/group/memory/docs/job-tracker.json.'
  );
  updates['task-1774364980425-2ez3de'] = p;
}

// ─── gmail_scan_530 ──────────────────────────────────────────────────────────
{
  const t = db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 'task-1774364987262-yy64gn'").get();
  let p = t.prompt;
  p = p.replace(
    '- last_model: "qwen3-vl:8b"\n\nSTEP 6 — Deregister\nRemove "gmail_scan_530" from active_jobs in /workspace/group/memory/docs/job-tracker.json.',
    '- last_model: "qwen3-vl:8b"\n- last_tokens: 0\n\nSTEP 5.5 — Log token usage\n' + logCmd('gmail_scan_530', 'qwen3-vl:8b') + '\n\nSTEP 6 — Deregister\nRemove "gmail_scan_530" from active_jobs in /workspace/group/memory/docs/job-tracker.json.'
  );
  updates['task-1774364987262-yy64gn'] = p;
}

// ─── self_check ──────────────────────────────────────────────────────────────
{
  const t = db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 'task-1774464347080-uol06p'").get();
  let p = t.prompt;
  p = p.replace(
    'Write to /workspace/group/memory/docs/job-status.json: self_check last_run = now ISO, last_status = "ok" or "error".',
    'Write to /workspace/group/memory/docs/job-status.json: self_check last_run = now ISO, last_status = "ok" or "error", last_tokens = 0.'
  );
  p = p.replace(
    'STEP 6 — Deregister\nRemove "self_check" from active_jobs in /workspace/group/memory/docs/job-tracker.json.',
    'STEP 5.5 — Log token usage\n' + logCmd('self_check', 'gemma3:4b') + '\n\nSTEP 6 — Deregister\nRemove "self_check" from active_jobs in /workspace/group/memory/docs/job-tracker.json.'
  );
  updates['task-1774464347080-uol06p'] = p;
}

// ─── journey_update ──────────────────────────────────────────────────────────
{
  const t = db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 'task-1774306881015-v6mdte'").get();
  let p = t.prompt;

  // STEP 3: add reading token file
  p = p.replace(
    'STEP 3 — Compose journey entry\nSummarise what happened today based on job-status.json last_run times and any notable activity.',
    "STEP 3 — Compose journey entry\nSummarise what happened today based on job-status.json last_run times and any notable activity.\n\nRead today's token usage: /workspace/group/memory/docs/token-usage-YYYY-MM-DD.json (YYYY-MM-DD = today in ET). If it exists, note claude.total and ollama.total. If not, skip gracefully."
  );

  // STEP 4: add token paragraph before divider
  p = p.replace(
    '- paragraph: summary of today\'s activity\n- divider',
    "- paragraph: summary of today's activity\n- paragraph: \"Tokens today: X Claude · Y Ollama\" (omit if token file not found)\n- divider"
  );

  // STEP 5: add token line in message format
  p = p.replace(
    '*Jobs ran today:*\n[bullet list of jobs with ✅/🔴 status]\n\n[timestamp: e.g. Mar 27 · 11:59 PM EDT]',
    '*Jobs ran today:*\n[bullet list of jobs with ✅/🔴 status]\n\nTokens today: X Claude · Y Ollama\n(omit if token file not found)\n\n[timestamp: e.g. Mar 27 · 11:59 PM EDT]'
  );

  // STEP 6: add last_tokens + STEP 6.5 + keep STEP 7
  p = p.replace(
    'STEP 6 — Update job status\nWrite to /workspace/group/memory/docs/job-status.json: journey_update last_run = now ISO, last_status = "ok", last_model = "gemma3:4b".\n\nSTEP 7 — Deregister\nRemove "journey_update" from active_jobs in /workspace/group/memory/docs/job-tracker.json.',
    'STEP 6 — Update job status\nWrite to /workspace/group/memory/docs/job-status.json: journey_update last_run = now ISO, last_status = "ok", last_model = "gemma3:4b", last_tokens = 0.\n\nSTEP 6.5 — Log token usage\n' + logCmd('journey_update', 'gemma3:4b') + '\n\nSTEP 7 — Deregister\nRemove "journey_update" from active_jobs in /workspace/group/memory/docs/job-tracker.json.'
  );
  updates['task-1774306881015-v6mdte'] = p;
}

// ─── gmail_scan_830 (simple prompt) ──────────────────────────────────────────
{
  const t = db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 'task-1774360790421-5qge8k'").get();
  let p = t.prompt.trimEnd();
  p += '\n\nAfter sending, log token usage:\n' + logCmd('gmail_scan_830', 'qwen3-vl:8b');
  updates['task-1774360790421-5qge8k'] = p;
}

// ─── learning_agent (simple prompt) ──────────────────────────────────────────
{
  const t = db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 'task-1774226620914-4ll2ho'").get();
  let p = t.prompt.trimEnd();
  p += '\n\nAfter sending, log token usage:\n' + logCmd('learning_agent', 'deepseek-r1:8b');
  updates['task-1774226620914-4ll2ho'] = p;
}

// ─── clean_logs (add STEP 2.5 for token-usage file cleanup) ──────────────────
{
  const t = db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 'task-1774117814090-7r7vv5'").get();
  let p = t.prompt;
  const cleanupCmd = `node -e "const fs=require('fs'),path=require('path');const dir='/workspace/group/memory/docs';const cutoff=Date.now()-30*24*60*60*1000;try{fs.readdirSync(dir).filter(f=>f.startsWith('token-usage-')&&f.endsWith('.json')).forEach(f=>{const fp=path.join(dir,f);if(fs.statSync(fp).mtimeMs<cutoff){fs.unlinkSync(fp);console.log('Deleted:',f);}});console.log('Token usage cleanup done');}catch(e){console.error('Token cleanup error:',e.message);}"`;
  const step25 = '\nSTEP 2.5 — Clean up old token usage files\n' + cleanupCmd + '\n\n';
  p = p.replace(
    'STEP 3 — Hard-delete old Archived Notion rows:',
    step25 + 'STEP 3 — Hard-delete old Archived Notion rows:'
  );
  updates['task-1774117814090-7r7vv5'] = p;
}

// ─── Apply all updates ────────────────────────────────────────────────────────
let ok = 0, fail = 0;
for (const [id, prompt] of Object.entries(updates)) {
  try {
    const result = db.prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ?').run(prompt, id);
    if (result.changes === 1) { ok++; console.log('✓', id); }
    else { fail++; console.log('✗ no row', id); }
  } catch(e) { fail++; console.log('✗ error', id, e.message); }
}
console.log(`\nDone: ${ok} updated, ${fail} failed`);
