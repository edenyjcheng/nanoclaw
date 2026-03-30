import crypto from 'crypto';
import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const CLASSIFIER_MODEL = process.env.OLLAMA_CLASSIFY_MODEL || 'gemma3:4b';
const CLASSIFIER_DATA_DIR = path.resolve(
  process.env.CLASSIFIER_DATA_DIR || path.join(process.cwd(), 'data/classifier'),
);
const KEYWORDS_PATH = path.join(CLASSIFIER_DATA_DIR, 'classifier-keywords.json');
const REROUTE_LOG_PATH = path.join(CLASSIFIER_DATA_DIR, 'reroute-log.json');

export interface RerouteEntry {
  id: string;
  timestamp: string;
  originalMessage: string;
  ollamaResponse: string;
  sniffTrigger: string;
  chatJid: string;
  processed: boolean;
}

export const classifierEvents = new EventEmitter();

// Keyword cache
let cachedKeywords: string[] = [];
let keywordCacheExpiry = 0;
const KEYWORD_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function loadKeywords(): Promise<string[]> {
  if (Date.now() < keywordCacheExpiry && cachedKeywords.length > 0) {
    return cachedKeywords;
  }
  try {
    const raw = fs.readFileSync(KEYWORDS_PATH, 'utf8');
    const data = JSON.parse(raw) as { keywords: string[] };
    cachedKeywords = data.keywords || [];
    keywordCacheExpiry = Date.now() + KEYWORD_CACHE_TTL;
  } catch (err) {
    logger.warn({ err }, 'Classifier: failed to load keywords, using cached');
  }
  return cachedKeywords;
}

export function invalidateKeywordCache(): void {
  keywordCacheExpiry = 0;
}

// Layer 2: Ollama classify
async function ollamaClassify(text: string): Promise<'CHAT' | 'TASK'> {
  try {
    const prompt =
      `Reply TASK if the message needs tools, calendar, email, files, web search, ` +
      `reminders, or any personal data access. Reply CHAT only if it is clearly ` +
      `casual conversation with no action needed. When in doubt, reply TASK. ` +
      `Message: ${text}`;

    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 5 },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`Ollama classify HTTP ${res.status}`);
    const data = (await res.json()) as { response: string };
    const first = data.response.trim().slice(0, 10).toUpperCase();
    return first.startsWith('CHAT') ? 'CHAT' : 'TASK';
  } catch (err) {
    logger.warn({ err }, 'Classifier: Ollama classify failed, defaulting to TASK');
    return 'TASK';
  }
}

export async function classifyMessage(text: string): Promise<'CHAT' | 'TASK'> {
  // Layer 1: keyword pre-filter
  const keywords = await loadKeywords();
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) return 'TASK';
  }
  // Layer 2: Ollama classify
  return await ollamaClassify(text);
}

// Layer 3: response sniff — detect capability-limit phrases
const SNIFF_PHRASES = [
  "i don't have access",
  "i can't access",
  "i'm not able to",
  "i don't have the ability",
  "i cannot check",
  "i can't check",
];

export function sniffResponse(response: string): string | null {
  const lower = response.toLowerCase();
  for (const phrase of SNIFF_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

export function logReroute(entry: RerouteEntry): void {
  const writeWithRetry = (attempt: number) => {
    try {
      const raw = fs.readFileSync(REROUTE_LOG_PATH, 'utf8');
      const log = JSON.parse(raw) as { entries: RerouteEntry[] };
      log.entries.push(entry);
      fs.writeFileSync(REROUTE_LOG_PATH, JSON.stringify(log, null, 2));
    } catch (err) {
      if (attempt < 2) {
        setTimeout(() => writeWithRetry(attempt + 1), 50);
      } else {
        logger.warn({ err }, 'Classifier: failed to write reroute log after 2 retries');
      }
    }
  };
  writeWithRetry(0);
}

export function checkAndTriggerLearningAgent(groupFolder: string): void {
  try {
    const raw = fs.readFileSync(REROUTE_LOG_PATH, 'utf8');
    const log = JSON.parse(raw) as { entries: RerouteEntry[] };
    const unprocessed = log.entries.filter((e) => !e.processed);
    if (unprocessed.length >= 5) {
      logger.info(
        { count: unprocessed.length },
        'Classifier: 5 reroutes accumulated, running learning agent',
      );
      scheduleLearningAgent(groupFolder, unprocessed, log).catch((err) =>
        logger.warn({ err }, 'Classifier learning agent failed'),
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Classifier: could not check reroute count');
  }
}

async function scheduleLearningAgent(
  _groupFolder: string,
  unprocessed: RerouteEntry[],
  log: { entries: RerouteEntry[] },
): Promise<void> {
  const LEARNING_MODEL = 'deepseek-r1:8b';

  const messages = unprocessed
    .map((e) => `Message: "${e.originalMessage}" | Sniff trigger: "${e.sniffTrigger}"`)
    .join('\n');

  const learningPrompt = `You are analyzing misclassified messages from a chat assistant. These messages were sent to Ollama (chat model) but Ollama could not handle them because they required tool access. Analyze the patterns and extract keywords or short phrases that would have identified these as TASK messages requiring tools.

Messages that were misclassified:
${messages}

For each keyword or phrase you identify:
- If it appears in 3 or more messages: mark as HIGH_CONFIDENCE
- If it appears in 1-2 messages: mark as LOW_CONFIDENCE

Reply ONLY with a JSON array, no explanation. Format:
[
  {"keyword": "phrase here", "confidence": "HIGH_CONFIDENCE", "occurrences": 3},
  {"keyword": "another phrase", "confidence": "LOW_CONFIDENCE", "occurrences": 1}
]`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LEARNING_MODEL,
      prompt: learningPrompt,
      stream: false,
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) throw new Error(`Ollama learning HTTP ${res.status}`);
  const data = (await res.json()) as { response: string };

  const cleaned = data.response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in learning response');

  const patterns = JSON.parse(jsonMatch[0]) as Array<{
    keyword: string;
    confidence: 'HIGH_CONFIDENCE' | 'LOW_CONFIDENCE';
    occurrences: number;
  }>;

  const highConf = patterns.filter((p) => p.confidence === 'HIGH_CONFIDENCE');
  const lowConf = patterns.filter((p) => p.confidence === 'LOW_CONFIDENCE');

  if (highConf.length > 0) {
    const kwRaw = fs.readFileSync(KEYWORDS_PATH, 'utf8');
    const kwFile = JSON.parse(kwRaw) as {
      version: number;
      updated: string;
      keywords: string[];
    };
    const existing = new Set(kwFile.keywords.map((k) => k.toLowerCase()));
    for (const p of highConf) {
      if (!existing.has(p.keyword.toLowerCase())) {
        kwFile.keywords.push(p.keyword);
        existing.add(p.keyword.toLowerCase());
      }
    }
    kwFile.updated = new Date().toISOString().slice(0, 10);
    kwFile.version += 1;
    fs.writeFileSync(KEYWORDS_PATH, JSON.stringify(kwFile, null, 2));
    invalidateKeywordCache();

    const logEntry = [
      `\n## Learning run — ${new Date().toISOString()}`,
      `Auto-added ${highConf.length} keyword(s): ${highConf.map((p) => `"${p.keyword}"`).join(', ')}`,
      lowConf.length > 0
        ? `Pending approval (low confidence): ${lowConf.map((p) => `"${p.keyword}"`).join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    fs.appendFileSync(
      path.join(CLASSIFIER_DATA_DIR, 'classifier-learning-log.md'),
      logEntry + '\n',
    );
  }

  // Mark entries processed
  for (const entry of unprocessed) {
    entry.processed = true;
  }
  fs.writeFileSync(REROUTE_LOG_PATH, JSON.stringify(log, null, 2));

  classifierEvents.emit('learned', {
    autoAdded: highConf.map((p) => p.keyword),
    pendingApproval: lowConf.map((p) => p.keyword),
  });
}
