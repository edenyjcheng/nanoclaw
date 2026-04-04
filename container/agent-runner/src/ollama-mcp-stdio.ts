/**
 * Ollama MCP Server for NanoClaw
 * Exposes local Ollama models as tools for the container agent.
 * Uses host.docker.internal to reach the host's Ollama instance from Docker.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import fs from 'fs';
import path from 'path';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
const OLLAMA_STATUS_FILE = '/workspace/ipc/ollama_status.json';
const GROUP_DOCS_DIR = '/workspace/group/memory/docs';
const JOB_TRACKER_PATH = `${GROUP_DOCS_DIR}/job-tracker.json`;

function log(msg: string): void {
  console.error(`[OLLAMA] ${msg}`);
}

function writeStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${OLLAMA_STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(OLLAMA_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, OLLAMA_STATUS_FILE);
  } catch { /* best-effort */ }
}

function getActiveJobName(): string {
  try {
    if (!fs.existsSync(JOB_TRACKER_PATH)) return 'unknown';
    const tracker = JSON.parse(fs.readFileSync(JOB_TRACKER_PATH, 'utf8'));
    const keys = Object.keys(tracker.active_jobs || {});
    return keys.length > 0 ? keys[0] : 'unknown';
  } catch {
    return 'unknown';
  }
}

function logOllamaTokens(model: string, tokens: number): void {
  if (tokens <= 0) return;
  try {
    const tz = process.env.TZ || 'America/New_York';
    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const filePath = path.join(GROUP_DOCS_DIR, `token-usage-${dateStr}.json`);

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

    const jobName = getActiveJobName();
    data.ollama.total += tokens;
    data.ollama.by_job[jobName] = (data.ollama.by_job[jobName] || 0) + tokens;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    log(`Token usage logged: ${jobName} +${tokens} (${model})`);
  } catch (err) {
    log(`Failed to log token usage: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ollamaFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${OLLAMA_HOST}${path}`;
  try {
    return await fetch(url, options);
  } catch (err) {
    // Fallback to localhost if host.docker.internal fails
    if (OLLAMA_HOST.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallbackUrl, options);
    }
    throw err;
  }
}

const server = new McpServer({
  name: 'ollama',
  version: '1.0.0',
});

server.tool(
  'ollama_list_models',
  'List all locally installed Ollama models. Use this to see which models are available before calling ollama_generate.',
  {},
  async () => {
    log('Listing models...');
    writeStatus('listing', 'Listing available models');
    try {
      const res = await ollamaFetch('/api/tags');
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `Ollama API error: ${res.status} ${res.statusText}` }],
          isError: true,
        };
      }

      const data = await res.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
      const models = data.models || [];

      if (models.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No models installed. Run `ollama pull <model>` on the host to install one.' }] };
      }

      const list = models
        .map(m => `- ${m.name} (${(m.size / 1e9).toFixed(1)}GB)`)
        .join('\n');

      log(`Found ${models.length} models`);
      return { content: [{ type: 'text' as const, text: `Installed models:\n${list}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to Ollama at ${OLLAMA_HOST}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_generate',
  'Send a prompt to a local Ollama model and get a response. Good for cheaper/faster tasks like summarization, translation, or general queries. Use ollama_list_models first to see available models.',
  {
    model: z.string().describe('The model name (e.g., "llama3.2", "mistral", "gemma2")'),
    prompt: z.string().describe('The prompt to send to the model'),
    system: z.string().optional().describe('Optional system prompt to set model behavior'),
  },
  async (args) => {
    log(`>>> Generating with ${args.model} (${args.prompt.length} chars)...`);
    writeStatus('generating', `Generating with ${args.model}`);
    try {
      const body: Record<string, unknown> = {
        model: args.model,
        prompt: args.prompt,
        stream: false,
      };
      if (args.system) {
        body.system = args.system;
      }

      const res = await ollamaFetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `Ollama error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }

      const data = await res.json() as { response: string; total_duration?: number; eval_count?: number };

      let meta = '';
      if (data.total_duration) {
        const secs = (data.total_duration / 1e9).toFixed(1);
        meta = `\n\n[${args.model} | ${secs}s${data.eval_count ? ` | ${data.eval_count} tokens` : ''}]`;
        log(`<<< Done: ${args.model} | ${secs}s | ${data.eval_count || '?'} tokens | ${data.response.length} chars`);
        writeStatus('done', `${args.model} | ${secs}s | ${data.eval_count || '?'} tokens`);
        if (data.eval_count) logOllamaTokens(args.model, data.eval_count);
      } else {
        log(`<<< Done: ${args.model} | ${data.response.length} chars`);
        writeStatus('done', `${args.model} | ${data.response.length} chars`);
      }

      return { content: [{ type: 'text' as const, text: data.response + meta }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to call Ollama: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
