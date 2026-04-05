// Channel auto-discovery barrel file.
// Dynamically imports all channel modules in this directory,
// excluding registry, index, and test files. Each channel self-registers
// via registerChannel() on import.
//
// This avoids hardcoded import lines that get wiped during upstream rebases
// (upstream removes skill-branch channel code from this file).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKIP = /^(index|registry)\./;
const EXCLUDE = /\.(test|d)\./;

// In dist/ we have .js files; in src/ we have .ts files (dev via tsx).
const allFiles = fs.readdirSync(__dirname);
const hasJs = allFiles.some((f) => f.endsWith('.js') && !f.endsWith('.d.js'));
const ext = hasJs ? '.js' : '.ts';
const channelFiles = allFiles.filter(
  (f) =>
    f.endsWith(ext) &&
    !f.endsWith('.d.ts') &&
    !SKIP.test(f) &&
    !EXCLUDE.test(f),
);

await Promise.all(channelFiles.map((f) => import(`./${f}`)));
