/**
 * Conversation queue — stores user requests that arrived while in Ollama
 * fallback mode and need Claude API to execute properly.
 *
 * Queue is persisted per-group to groups/{folder}/memory/claude-queue.json.
 * On recovery, the host reads the queue, presents items to the user, and
 * processes confirmed ones through the normal agent pipeline.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

export interface QueuedItem {
  id: string;
  chatJid: string;
  prompt: string;     // original formatted message(s) to re-run through agent
  summary: string;    // short label shown to user (first 120 chars of last user line)
  queuedAt: string;
}

function queueFile(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'memory', 'claude-queue.json');
}

export function loadQueue(groupFolder: string): QueuedItem[] {
  const file = queueFile(groupFolder);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveQueue(groupFolder: string, queue: QueuedItem[]): void {
  const dir = path.dirname(queueFile(groupFolder));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(queueFile(groupFolder), JSON.stringify(queue, null, 2), 'utf-8');
}

export function addToQueue(
  groupFolder: string,
  chatJid: string,
  prompt: string,
  summary: string,
): QueuedItem {
  const queue = loadQueue(groupFolder);
  const item: QueuedItem = {
    id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    chatJid,
    prompt,
    summary: summary.slice(0, 120),
    queuedAt: new Date().toISOString(),
  };
  queue.push(item);
  saveQueue(groupFolder, queue);
  return item;
}

export function removeFromQueue(groupFolder: string, ids: Set<string>): void {
  const queue = loadQueue(groupFolder).filter((i) => !ids.has(i.id));
  saveQueue(groupFolder, queue);
}

export function clearQueue(groupFolder: string): void {
  saveQueue(groupFolder, []);
}
