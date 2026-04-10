import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

interface OllamaConfig {
  models: {
    chat: string;
    reason: string;
    vision: string;
    memory_agent: string;
  };
  timeouts: {
    gemma_chat: number;
    deepseek_reason: number;
    qwen_vision: number;
    memory_agent: number;
  };
}

const DEFAULTS: OllamaConfig = {
  models: {
    chat: 'qwen2.5:7b',
    reason: 'gemma3:12b',
    vision: 'gemma3:12b',
    memory_agent: 'phi4-mini:latest',
  },
  timeouts: {
    gemma_chat: 30,
    deepseek_reason: 90,
    qwen_vision: 90,
    memory_agent: 45,
  },
};

function findConfigPath(): string {
  // Explicit env var takes priority
  if (process.env.OLLAMA_CONFIG_PATH) return process.env.OLLAMA_CONFIG_PATH;

  // Scan groups for the first ollama-config.json
  try {
    for (const entry of fs.readdirSync(GROUPS_DIR)) {
      const candidate = path.join(
        GROUPS_DIR,
        entry,
        'memory',
        'ollama-config.json',
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // GROUPS_DIR doesn't exist or isn't readable
  }

  // Fallback: container path (useful when running inside a container)
  return '/workspace/group/memory/ollama-config.json';
}

function loadConfig(): OllamaConfig {
  try {
    const raw = fs.readFileSync(findConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      models: { ...DEFAULTS.models, ...parsed.models },
      timeouts: { ...DEFAULTS.timeouts, ...parsed.timeouts },
    };
  } catch {
    return DEFAULTS;
  }
}

// Loaded once at startup — restart NanoClaw to pick up config changes
export const ollamaConfig = loadConfig();

export const MODELS = ollamaConfig.models;
export const TIMEOUTS = ollamaConfig.timeouts;
