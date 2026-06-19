#!/usr/bin/env node
/*
 * Patch @notionhq/notion-mcp-server's bundled CLI so the `update-a-block`
 * operation sends a Notion-valid PATCH body.
 *
 * Why: Notion's "Update a block" API forbids a top-level `type` key in the
 * request body — the block-type object (e.g. { bulleted_list_item: {...} })
 * must be spread at the top level:
 *     { "bulleted_list_item": { "rich_text": [...] } }
 * The bundled OpenAPI spec declares a `type` body property, so the generic
 * http-client emits `{ "type": {...} }` and Notion replies
 * "body.type should be not present".
 *
 * The runtime entry point (/usr/local/bin/notion-mcp-server) is an esbuild
 * bundle with minified identifiers — the build/src/*.js files are NOT executed.
 * So we patch the bundle's `executeOperation` method directly, just before the
 * operation function is dispatched, leaving the MCP tool input convention
 * unchanged (callers still pass `type: { bulleted_list_item: {...} }`).
 *
 * Resilience: the minified variable names (operationId / formData / bodyParams)
 * are recovered by regex from stable structural anchors, so the patch survives
 * identifier reshuffling. It is idempotent and fails loudly if the upstream
 * structure changes (e.g. a notion-mcp-server upgrade), so the build surfaces
 * drift instead of silently shipping the bug.
 *
 * Ref IPC: groups/telegram_main/ipc-claudecode/requests/20260605-1045-notion-mcp-update-block-fix.md
 */
const fs = require('fs');

const FILE = process.argv[2] || '/usr/local/bin/notion-mcp-server';
const MARKER = 'nanoclaw-ub';

function fail(msg) {
  console.error(`[patch-notion-mcp] ERROR: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(FILE)) fail(`target file not found: ${FILE}`);
let src = fs.readFileSync(FILE, 'utf8');

if (src.includes(MARKER)) {
  console.log('[patch-notion-mcp] already patched — no-op');
  process.exit(0);
}

// Recover minified variable names from the (unique) executeOperation body.
//   <formData>=await this.prepareFileUpload(t,r),<tmp>={},<bodyParams>=<formData>||{...
const fdM = src.match(
  /(\w+)=await this\.prepareFileUpload\([^)]*\),\w+=\{\},(\w+)=\1\|\|\{\.\.\./,
);
if (!fdM) fail('could not locate prepareFileUpload/bodyParams region');
const formData = fdM[1];
const body = fdM[2];

// Insertion point: just before the operation-function lookup
//   let <fn>=<api>[<opId>];if(!<fn>)throw new Error(`Operation ...
// <opId> is recovered from the index expression in this very anchor, so it is
// guaranteed to match the variable the runtime actually uses.
const anchorRe = /let (\w+)=\w+\[(\w+)\];if\(!\1\)throw new Error\(`Operation /;
const anchorM = src.match(anchorRe);
if (!anchorM) fail('could not locate operation-function lookup anchor');
const opId = anchorM[2];

const inject =
  `if(${opId}==="update-a-block"&&!${formData}&&${body}&&typeof ${body}=="object"` +
  `&&${body}.type&&typeof ${body}.type=="object"){` +
  `let{type:_nbt,..._nrb}=${body};${body}={..._nrb,..._nbt};}/*${MARKER}*/`;

src = src.replace(anchorRe, inject + anchorM[0]);

fs.writeFileSync(FILE, src, 'utf8');
console.log(
  `[patch-notion-mcp] patched executeOperation (opId=${opId} formData=${formData} body=${body}) OK`,
);
