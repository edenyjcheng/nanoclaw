import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { MODELS } from './ollama-config.js';
import {
  startCredentialProxy,
  credentialEvents,
  setForcedAuthMode,
  resetRecoveryState,
} from './credential-proxy.js';
import {
  addToQueue,
  clearQueue,
  loadQueue,
  removeFromQueue,
  type QueuedItem,
} from './conversation-queue.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  createTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTaskById,
  initDatabase,
  updateTask,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';

import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

// --- PID file guard: prevent duplicate NanoClaw instances ---
const PID_FILE = path.join(DATA_DIR, 'nanoclaw.pid');

function acquirePidLock(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      // Check if the old process is still running
      try {
        process.kill(oldPid, 0); // signal 0 = existence check
        logger.warn(
          { oldPid },
          'Found existing NanoClaw process — killing to prevent duplicates',
        );
        // On Windows, SIGTERM doesn't reliably kill cmd.exe/npm wrappers.
        // Use taskkill /T to kill the process tree.
        if (process.platform === 'win32') {
          try {
            execSync(`taskkill /PID ${oldPid} /T /F`, { stdio: 'pipe' });
          } catch {
            // taskkill may fail if already exiting
            try {
              process.kill(oldPid, 'SIGTERM');
            } catch {
              /* already dead */
            }
          }
        } else {
          process.kill(oldPid, 'SIGTERM');
        }
        // Brief wait for graceful exit before we proceed
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try {
            process.kill(oldPid, 0);
          } catch {
            break; // process exited
          }
          // busy-wait in small increments (sync startup path, only runs once)
          const waitUntil = Date.now() + 200;
          while (Date.now() < waitUntil) {
            /* spin */
          }
        }
      } catch {
        // process doesn't exist — stale PID file, safe to overwrite
      }
    }
  }

  fs.writeFileSync(PID_FILE, String(process.pid));
}

function releasePidLock(): void {
  try {
    const stored = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (stored === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    /* ignore */
  }
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Groups pending a startup warmup (chatJid -> true)
const startupWarmupPending = new Map<string, boolean>();

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_WARMUP_MODEL = process.env.OLLAMA_WARMUP_MODEL || MODELS.chat;

/**
 * Ask a local Ollama model to generate the startup "back online" message.
 * Falls back to a static string if Ollama is unavailable or has no models.
 */
async function ollamaWarmupMessage(assistantName: string): Promise<string> {
  try {
    // Use configured model or fall back to first available
    let model = OLLAMA_WARMUP_MODEL;
    if (!model) {
      const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
      if (!tagsRes.ok) throw new Error(`tags ${tagsRes.status}`);
      const tags = (await tagsRes.json()) as {
        models?: Array<{ name: string }>;
      };
      model = tags.models?.[0]?.name ?? '';
      if (!model) throw new Error('no models installed');
    }

    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: `You are ${assistantName}, a personal AI assistant. Write a single short sentence (under 15 words) telling the user you are back online and ready to help. No greeting, no fluff.`,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`generate ${res.status}`);
    const data = (await res.json()) as {
      response: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const tokens = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);
    if (tokens > 0) logOllamaTokenUsage(tokens, model);
    return data.response.trim();
  } catch (err) {
    logger.warn({ err }, 'Ollama warmup failed, using static message');
    return `${assistantName} is back online and ready.`;
  }
}

// --- Ollama fallback mode ---
// Activated when both OAuth and API key are rate-limited.
// In this mode, incoming messages are answered directly via Ollama (no container).
let ollamaFallbackActive = false;
let ollamaFallbackNotified = false;

// Last user prompt per chatJid while in Ollama mode — used when user replies "queue"
const lastOllamaPrompt = new Map<string, { prompt: string; summary: string }>();
// Groups waiting for the user to pick which queued items to run after recovery
const pendingQueueReview = new Map<string, QueuedItem[]>();

async function sendToMainGroup(text: string): Promise<void> {
  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  if (!mainEntry) return;
  const [chatJid] = mainEntry;
  const ch = findChannel(channels, chatJid);
  await ch?.sendMessage(chatJid, text);
}

function extractSummary(prompt: string): string {
  // Pull the last non-empty line as the user-visible summary
  const lines = prompt
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || prompt.slice(0, 120);
}

async function presentQueueOnRecovery(): Promise<void> {
  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  if (!mainEntry) return;
  const [chatJid, group] = mainEntry;
  const ch = findChannel(channels, chatJid);
  if (!ch) return;

  const queue = loadQueue(group.folder);
  if (queue.length === 0) {
    await ch.sendMessage(
      chatJid,
      `✅ Claude API is available again. Resuming normal mode with full tool access.`,
    );
    return;
  }

  const lines = [
    `✅ Claude API is back! You have ${queue.length} queued task(s) from Conversation Mode:\n`,
    ...queue.map((item, i) => `${i + 1}. ${item.summary}`),
    `\nReply with numbers to run (e.g. *1 3*), *all* to run all, or *skip* to clear the queue.`,
  ];
  pendingQueueReview.set(chatJid, queue);
  await ch.sendMessage(chatJid, lines.join('\n'));
}

async function callOllamaChat(prompt: string): Promise<string | null> {
  const model = OLLAMA_WARMUP_MODEL;
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0.7 },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as {
      message?: { content: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const tokens = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);
    logOllamaTokenUsage(tokens, model);
    const content = data.message?.content?.trim() || null;
    if (!content) {
      logOllamaFallback(model, 'empty');
    }
    return content;
  } catch (err) {
    const reason: 'timeout' | 'error' =
      err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'error';
    logger.warn({ err, reason }, 'Ollama chat failed');
    logOllamaFallback(model, reason);
    return null;
  }
}

// Wire up credential exhaustion events (proxy emits these)
credentialEvents.on('exhausted', () => {
  ollamaFallbackActive = true;
  if (!ollamaFallbackNotified) {
    ollamaFallbackNotified = true;
    logger.warn(
      'All Claude credentials exhausted — switching to Ollama fallback mode',
    );
    sendToMainGroup(
      `⚠️ Claude limits reached — running on Ollama (${OLLAMA_WARMUP_MODEL}). Tool use + agent spawning unavailable until limits reset. I'll automatically switch back when Claude is available.`,
    ).catch((err) =>
      logger.warn({ err }, 'Failed to send exhaustion notification'),
    );
  }
});

credentialEvents.on('recovered', () => {
  if (ollamaFallbackActive) {
    ollamaFallbackActive = false;
    ollamaFallbackNotified = false;
    logger.info('Claude credentials recovered — exiting Ollama fallback mode');
    // Notify and show queue if any items are pending
    presentQueueOnRecovery().catch((err) =>
      logger.warn({ err }, 'Failed to present queue on recovery'),
    );
  }
});

// Log real token counts captured by the credential proxy SSE tap.
// Writes to token-usage-YYYY-MM-DD.json in the main group's docs folder.
function logProxyTokenUsage(job: string, tokens: number): void {
  try {
    const mainEntry = Object.entries(registeredGroups).find(
      ([, g]) => g.isMain,
    );
    if (!mainEntry) return;
    const groupDir = resolveGroupFolderPath(mainEntry[1].folder);
    const docsDir = path.join(groupDir, 'logs', 'token-usage');
    fs.mkdirSync(docsDir, { recursive: true });
    const dateStr = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
    const filePath = path.join(docsDir, `token-usage-${dateStr}.json`);
    let data: {
      date: string;
      claude: { total: number; by_job: Record<string, number> };
      ollama: { total: number; by_job: Record<string, number> };
    };
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      data = {
        date: dateStr,
        claude: { total: 0, by_job: {} },
        ollama: { total: 0, by_job: {} },
      };
    }
    data.claude.total += tokens;
    data.claude.by_job[job] = (data.claude.by_job[job] || 0) + tokens;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    logger.debug({ job, tokens }, 'Token usage logged');
  } catch (err) {
    logger.warn({ err }, 'Failed to log token usage');
  }
}

function logOllamaTokenUsage(tokens: number, model: string): void {
  if (tokens <= 0) return;
  try {
    const mainEntry = Object.entries(registeredGroups).find(
      ([, g]) => g.isMain,
    );
    if (!mainEntry) return;
    const groupDir = resolveGroupFolderPath(mainEntry[1].folder);
    const docsDir = path.join(groupDir, 'logs', 'token-usage');
    fs.mkdirSync(docsDir, { recursive: true });
    const dateStr = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
    const filePath = path.join(docsDir, `token-usage-${dateStr}.json`);
    let data: {
      date: string;
      claude: { total: number; by_job: Record<string, number> };
      ollama: { total: number; by_job: Record<string, number> };
    };
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      data = {
        date: dateStr,
        claude: { total: 0, by_job: {} },
        ollama: { total: 0, by_job: {} },
      };
    }
    // G1+G2: single-path job lookup (matches agent-runner logic); default 'conversation' not 'unknown'
    let jobName = 'conversation';
    try {
      const trackerPath = path.join(groupDir, 'memory', 'job-tracker.json');
      if (fs.existsSync(trackerPath)) {
        const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
        const activeKeys = Object.keys(tracker.active_jobs || {});
        if (activeKeys.length > 0) jobName = activeKeys[0];
      }
    } catch {
      /* keep default */
    }
    data.ollama.total += tokens;
    data.ollama.by_job[jobName] = (data.ollama.by_job[jobName] || 0) + tokens;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    logger.debug({ jobName, tokens, model }, 'Ollama token usage logged');
  } catch (err) {
    logger.warn({ err }, 'Failed to log Ollama token usage');
  }
}

/** Log an Ollama fallback event (model failed, Claude handled instead). */
function logOllamaFallback(
  model: string,
  reason: 'timeout' | 'error' | 'empty',
): void {
  try {
    const mainEntry = Object.entries(registeredGroups).find(
      ([, g]) => g.isMain,
    );
    if (!mainEntry) return;
    const groupDir = resolveGroupFolderPath(mainEntry[1].folder);
    const logsDir = path.join(groupDir, 'logs');
    const filePath = path.join(logsDir, 'ollama-fallback-log.json');
    let entries: Array<{
      event: string;
      model: string;
      reason: string;
      timestamp: string;
    }>;
    try {
      entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      entries = [];
    }
    entries.push({
      event: 'ollama_fallback',
      model,
      reason,
      timestamp: new Date().toISOString(),
    });
    // Keep last 200 entries
    if (entries.length > 200) entries = entries.slice(-200);
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
    logger.info({ model, reason }, 'Ollama fallback logged');
  } catch (err) {
    logger.warn({ err }, 'Failed to log Ollama fallback');
  }
}

credentialEvents.on(
  'usage',
  ({ total }: { inputTokens: number; outputTokens: number; total: number }) => {
    if (total <= 0) return;
    // Determine active job from any group's job-tracker.json
    let jobName = 'unknown';
    for (const group of Object.values(registeredGroups)) {
      try {
        const groupDir = resolveGroupFolderPath(group.folder);
        const trackerPath = path.join(groupDir, 'memory', 'job-tracker.json');
        if (!fs.existsSync(trackerPath)) continue;
        const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
        const activeKeys = Object.keys(tracker.active_jobs || {});
        if (activeKeys.length > 0) {
          jobName = activeKeys[0];
          break;
        }
      } catch {
        /* continue */
      }
    }
    logProxyTokenUsage(jobName, total);
  },
);

export type LlmMode = 'auto' | 'oauth' | 'api-key' | 'ollama';

/**
 * Manually switch the LLM mode. Called by Cortana via IPC set_llm_mode command.
 *   auto     — default: OAuth → API key fallback → Ollama on exhaustion
 *   oauth    — force OAuth only (no API key fallback)
 *   api-key  — force ANTHROPIC_API_KEY only (skip OAuth)
 *   ollama   — skip containers entirely, answer via Ollama (conversation only)
 */
export function setLlmMode(mode: LlmMode): void {
  logger.info({ mode }, 'LLM mode changed by Cortana');
  switch (mode) {
    case 'auto':
      setForcedAuthMode(null);
      resetRecoveryState();
      ollamaFallbackActive = false;
      ollamaFallbackNotified = false;
      break;
    case 'oauth':
      setForcedAuthMode('oauth');
      resetRecoveryState();
      ollamaFallbackActive = false;
      ollamaFallbackNotified = false;
      break;
    case 'api-key':
      setForcedAuthMode('api-key');
      resetRecoveryState();
      ollamaFallbackActive = false;
      ollamaFallbackNotified = false;
      break;
    case 'ollama':
      setForcedAuthMode(null);
      ollamaFallbackActive = true;
      ollamaFallbackNotified = true; // suppress auto-exhaustion notification
      break;
  }
}

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res: { created: boolean }) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err: unknown) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Ensure memory queue files exist for all registered groups (Memory Agent writes here)
  for (const group of Object.values(registeredGroups)) {
    try {
      const groupDir = resolveGroupFolderPath(group.folder);
      fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
      const triggerQ = path.join(groupDir, 'memory', 'mem0-trigger-queue.json');
      const mem0Q = path.join(groupDir, 'memory', 'mem0-queue.json');
      if (!fs.existsSync(triggerQ)) {
        fs.writeFileSync(triggerQ, JSON.stringify([], null, 2));
      }
      if (!fs.existsSync(mem0Q)) {
        fs.writeFileSync(mem0Q, JSON.stringify([], null, 2));
      }
    } catch {
      // Best-effort — group folder may not exist yet
    }
  }

  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder and memory queue files
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
  const triggerQueuePath = path.join(
    groupDir,
    'memory',
    'mem0-trigger-queue.json',
  );
  const mem0QueuePath = path.join(groupDir, 'memory', 'mem0-queue.json');
  if (!fs.existsSync(triggerQueuePath)) {
    fs.writeFileSync(triggerQueuePath, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(mem0QueuePath)) {
    fs.writeFileSync(mem0QueuePath, JSON.stringify([], null, 2));
  }

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  // No real messages — check for a pending startup warmup
  if (missedMessages.length === 0) {
    if (startupWarmupPending.get(chatJid)) {
      startupWarmupPending.delete(chatJid);
      logger.info({ group: group.name }, 'Running startup warmup via Ollama');
      await channel.setTyping?.(chatJid, true);
      const text = await ollamaWarmupMessage(ASSISTANT_NAME);
      await channel.setTyping?.(chatJid, false);
      if (text) await channel.sendMessage(chatJid, text);
    }
    return true;
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const lastMsg = missedMessages[missedMessages.length - 1];
  const lastContent = lastMsg.content.trim().toLowerCase();

  // --- Queue review: user is responding to the recovery queue list ---
  const reviewQueue = pendingQueueReview.get(chatJid);
  if (reviewQueue && reviewQueue.length > 0) {
    pendingQueueReview.delete(chatJid);
    lastAgentTimestamp[chatJid] = lastMsg.timestamp;
    saveState();

    if (lastContent === 'skip') {
      clearQueue(group.folder);
      await channel.sendMessage(chatJid, `🗑️ Queue cleared.`);
      return true;
    }

    let toRun: QueuedItem[];
    if (lastContent === 'all') {
      toRun = reviewQueue;
    } else {
      // Parse "1 3", "1,3", "1, 3" etc.
      const nums = lastContent
        .split(/[\s,]+/)
        .map(Number)
        .filter((n) => !isNaN(n) && n >= 1 && n <= reviewQueue.length);
      toRun = nums.map((n) => reviewQueue[n - 1]);
    }

    const skipped = reviewQueue.filter((i) => !toRun.includes(i));
    removeFromQueue(group.folder, new Set(skipped.map((i) => i.id)));

    if (toRun.length === 0) {
      clearQueue(group.folder);
      await channel.sendMessage(chatJid, `🗑️ Queue cleared.`);
      return true;
    }

    await channel.sendMessage(
      chatJid,
      `▶️ Running ${toRun.length} queued task(s)...`,
    );
    for (const item of toRun) {
      removeFromQueue(group.folder, new Set([item.id]));
      await runAgent(group, item.prompt, chatJid, async (result) => {
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (text) await channel.sendMessage(chatJid, text);
        }
      });
    }
    return true;
  }

  // --- Ollama mode: "queue" command — queue the last prompt for Claude ---
  if (
    ollamaFallbackActive &&
    (lastContent === 'queue' || lastContent === 'q')
  ) {
    const last = lastOllamaPrompt.get(chatJid);
    if (last) {
      addToQueue(group.folder, chatJid, last.prompt, last.summary);
      lastOllamaPrompt.delete(chatJid);
      lastAgentTimestamp[chatJid] = lastMsg.timestamp;
      saveState();
      await channel.sendMessage(
        chatJid,
        `✅ Queued. I'll remind you when Claude is back.`,
      );
    } else {
      await channel.sendMessage(
        chatJid,
        `Nothing to queue — send your request first, then reply "queue".`,
      );
      lastAgentTimestamp[chatJid] = lastMsg.timestamp;
      saveState();
    }
    return true;
  }

  // --- Agent-runner-first (Option A): skip Ollama classifier entirely ---
  // All messages route to the container agent. Ollama is only used as a
  // fallback when the agent runner is unavailable or errors out.
  // The classifier code has been removed to prevent double-response:
  // previously, CHAT-classified messages got an Ollama reply AND the
  // container agent could also respond via mcp__nanoclaw__send_message.

  // --- Ollama fallback mode: answer directly without spawning a container ---
  if (ollamaFallbackActive) {
    logger.info(
      { group: group.name },
      'Ollama fallback mode: routing to Ollama directly',
    );
    const model = OLLAMA_WARMUP_MODEL;
    const modeNotice = `⚠️ *Conversation Mode* — Claude API unavailable. Responding via Ollama (${model}). No tool access.\n\n`;
    await channel.setTyping?.(chatJid, true);
    const response = await callOllamaChat(prompt);
    await channel.setTyping?.(chatJid, false);

    // Save this prompt so user can reply "queue" to queue it for Claude
    lastOllamaPrompt.set(chatJid, { prompt, summary: extractSummary(prompt) });

    if (response) {
      await channel.sendMessage(
        chatJid,
        modeNotice +
          response +
          `\n\n_Reply_ \`queue\` _to save this task for Claude._`,
      );
    } else {
      await channel.sendMessage(
        chatJid,
        `⚠️ *Conversation Mode* — Claude API unavailable and Ollama also failed to respond. Please try again later.\n\n_Reply_ \`queue\` _to save this for Claude._`,
      );
    }
    lastAgentTimestamp[chatJid] = lastMsg.timestamp;
    saveState();
    return true;
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Agent-runner-first (Option A): container failed — try Ollama as fallback.
    // This covers credential exhaustion, container crashes, and any other error.
    logger.info(
      { group: group.name, ollamaFallbackActive },
      'Agent runner failed — falling back to Ollama',
    );
    const model = OLLAMA_WARMUP_MODEL;
    const modeNotice = `⚠️ *Conversation Mode* — Agent runner unavailable. Responding via Ollama (${model}). No tool access.\n\n`;
    await channel.setTyping?.(chatJid, true);
    const response = await callOllamaChat(prompt);
    await channel.setTyping?.(chatJid, false);
    lastOllamaPrompt.set(chatJid, {
      prompt,
      summary: extractSummary(prompt),
    });
    if (response) {
      await channel.sendMessage(
        chatJid,
        modeNotice +
          response +
          `\n\n_Reply_ \`queue\` _to save this task for Claude._`,
      );
      // Cursor is already advanced — no rollback needed
      saveState();
      return true;
    }
    // Both agent runner and Ollama failed — roll back cursor for retry
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Both agent runner and Ollama failed, rolled back cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — acknowledge immediately (covers cold-start latency)
            // then enqueue so the user isn't left waiting in silence
            channel
              .sendMessage(chatJid, 'Working on it...')
              .catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to send acknowledgment'),
              );
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/**
 * Queue a startup warmup for the main group.
 * Sends a short "back online" message via Ollama (no container spin-up).
 */
function startupWarmup(): void {
  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  if (!mainEntry) return;

  const [chatJid] = mainEntry;
  startupWarmupPending.set(chatJid, true);
  queue.enqueueMessageCheck(chatJid);
  logger.info({ chatJid }, 'Startup warmup enqueued');
}

/**
 * Startup job recovery: check for jobs that were interrupted by a crash.
 * Reads each group's job-tracker.json, moves active_jobs to interrupted_jobs,
 * schedules one-time re-runs (2 min from now), and sends a Telegram notification.
 */
async function recoverInterruptedJobs(
  sendNotification: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(group.folder);
    } catch {
      continue;
    }

    const trackerPath = path.join(groupDir, 'memory', 'job-tracker.json');
    if (!fs.existsSync(trackerPath)) continue;

    let tracker: {
      active_jobs: Record<
        string,
        {
          task_id?: string;
          started_at?: string;
          expected_duration_min?: number;
        }
      >;
      interrupted_jobs: Array<{
        job: string;
        task_id: string | null;
        started_at?: string;
        reason: string;
        recovered_at: string;
      }>;
      last_startup_check: string | null;
    };
    try {
      tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
    } catch {
      continue;
    }

    const activeJobs = tracker.active_jobs || {};
    const jobNames = Object.keys(activeJobs);

    const now = new Date().toISOString();
    tracker.last_startup_check = now;

    if (jobNames.length === 0) {
      fs.writeFileSync(trackerPath, JSON.stringify(tracker, null, 2));
      continue;
    }

    const requeued: string[] = [];
    tracker.interrupted_jobs = tracker.interrupted_jobs || [];

    for (const [jobName, jobInfo] of Object.entries(activeJobs)) {
      tracker.interrupted_jobs.push({
        job: jobName,
        task_id: jobInfo.task_id || null,
        started_at: jobInfo.started_at,
        reason: 'crash_recovery',
        recovered_at: now,
      });

      const taskId = jobInfo.task_id;
      if (taskId) {
        const originalTask = getTaskById(taskId);
        if (originalTask?.status === 'active') {
          const recoveryId = `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const runAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
          try {
            createTask({
              id: recoveryId,
              group_folder: originalTask.group_folder,
              chat_jid: originalTask.chat_jid,
              prompt: originalTask.prompt,
              schedule_type: 'once',
              schedule_value: runAt,
              context_mode: originalTask.context_mode || 'isolated',
              next_run: runAt,
              status: 'active',
              created_at: now,
            });
            requeued.push(jobName);
          } catch (err) {
            logger.warn(
              { err, job: jobName },
              'Job recovery: failed to re-queue',
            );
          }
        }
      }
    }

    tracker.active_jobs = {};
    fs.writeFileSync(trackerPath, JSON.stringify(tracker, null, 2));

    const msg =
      requeued.length > 0
        ? `🔄 *System restarted* — recovered ${requeued.length} interrupted job(s): ${requeued.join(', ')}. Re-queuing now.`
        : `🔄 *System restarted* — ${jobNames.length} interrupted job(s) found: ${jobNames.join(', ')}. Could not re-queue (task IDs not stored).`;

    logger.info(
      { group: group.name, jobNames, requeued },
      'Job recovery: processed interrupted jobs',
    );
    sendNotification(chatJid, msg).catch((err) =>
      logger.warn({ err }, 'Failed to send job recovery notification'),
    );
  }
}

async function main(): Promise<void> {
  acquirePidLock();
  ensureContainerSystemRunning();

  // Periodic orphan cleanup: on Windows, ghost containers appear from various
  // sources (in-flight docker-run from killed processes, scheduled tasks, etc).
  // This background loop kills any untracked nanoclaw containers every 10 seconds.
  setInterval(() => {
    try {
      const registered = queue.getActiveContainerNames();
      const output = execSync(
        `docker ps --filter name=nanoclaw- --format "{{.Names}}"`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (!output) return;
      const running = output.split('\n').filter(Boolean);
      const orphans = running.filter((n) => !registered.has(n));
      if (orphans.length > 0) {
        logger.warn({ orphans }, 'Killing untracked ghost containers');
        for (const name of orphans) {
          try {
            execSync(`docker rm -f ${name}`, { stdio: 'pipe', timeout: 5000 });
          } catch {
            /* already gone */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, 10000);
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Start credential proxy for container API requests
  const proxyServer = await startCredentialProxy(CREDENTIAL_PROXY_PORT);
  logger.info({ port: CREDENTIAL_PROXY_PORT }, 'Credential proxy started');

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    releasePidLock();
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Kill switch — main group only
      if (trimmed.startsWith('/kill')) {
        const group = registeredGroups[chatJid];
        if (!group?.isMain) return; // Silently ignore from non-main groups

        const reply = async (text: string) => {
          const ch = findChannel(channels, chatJid);
          if (ch) await ch.sendMessage(chatJid, text);
        };

        const arg = trimmed.slice(5).trim(); // text after "/kill"

        if (arg === 'all') {
          const killed = queue.killAll();
          if (killed.length === 0) {
            reply('No active containers to kill.').catch(() => {});
          } else {
            const lines = killed.map(
              (k) =>
                `• ${k.containerName}${k.taskId ? ` (task: ${k.taskId})` : ''}`,
            );
            for (const k of killed) {
              if (k.taskId) updateTask(k.taskId, { status: 'paused' });
            }
            reply(
              `Killed ${killed.length} container(s):\n${lines.join('\n')}`,
            ).catch(() => {});
          }
        } else if (arg && arg.startsWith('task-')) {
          // Pause a specific task by ID
          updateTask(arg, { status: 'paused' });
          reply(`Paused task: ${arg}`).catch(() => {});
        } else {
          // Kill active container for this group
          const result = queue.killGroup(chatJid);
          if (!result) {
            reply('No active container for this group.').catch(() => {});
          } else {
            if (result.taskId) updateTask(result.taskId, { status: 'paused' });
            reply(
              `Killed container: ${result.containerName}${result.taskId ? `\nPaused task: ${result.taskId}` : ''}`,
            ).catch(() => {});
          }
        }

        logger.info(
          { chatJid, command: trimmed },
          'Kill switch command executed',
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Startup job recovery: re-queue any jobs interrupted by a previous crash
  await recoverInterruptedJobs(async (jid, text) => {
    const channel = findChannel(channels, jid);
    if (channel) await channel.sendMessage(jid, formatOutbound(text));
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    setLlmMode,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startupWarmup();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests.
// NOTE: Do NOT simplify this back to `new URL('file://' + process.argv[1])` —
// on Windows, process.argv[1] is a relative path when invoked as `node dist/index.js`,
// which causes URL parsing to treat the first segment as a hostname (breaks silently).
// path.resolve() ensures we always get an absolute path before URL construction.
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${path.resolve(process.argv[1])}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
