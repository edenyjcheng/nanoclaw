import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

interface OllamaConfig {
  models: {
    chat: string;
    reason: string;
    vision: string;
    memory_agent: string;
    extraction: string;
  };
  timeouts: {
    chat: number;
    reason: number;
    vision: number;
    memory_agent: number;
    extraction: number;
  };
}

const DEFAULTS: OllamaConfig = {
  models: {
    chat: 'gemma4:12b',
    reason: 'qwen3:14b',
    vision: 'gemma4:12b',
    memory_agent: 'phi4-mini-reasoning:3.8b',
    extraction: 'granite4.1:8b',
  },
  timeouts: {
    chat: 25,
    reason: 95,
    vision: 150,
    memory_agent: 60,
    extraction: 90,
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

// Hot-reload: re-read config on file change, mutate in-place so existing references stay valid
const _config = loadConfig();

const configPath = findConfigPath();
try {
  fs.watch(configPath, { persistent: false }, (event) => {
    if (event === 'change') {
      const fresh = loadConfig();
      Object.assign(_config.models, fresh.models);
      Object.assign(_config.timeouts, fresh.timeouts);
      console.log(`[ollama-config] Reloaded from ${configPath}`);
    }
  });
} catch {
  // fs.watch not available or path not found — continue with static load
}

export const ollamaConfig = _config;

export const MODELS = _config.models;
export const TIMEOUTS = _config.timeouts;
