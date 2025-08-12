#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import chalk from 'chalk';

const ROOT_DIR = path.resolve(process.cwd());
const WORKDIR = path.join(ROOT_DIR, 'reverse/modium');
const UNPACKED = path.join(WORKDIR, 'unpacked');

if (!fs.existsSync(UNPACKED)) {
  console.error('[!] unpacked not found; run make reverse first');
  process.exit(1);
}

const result = {
  endpoints: new Set(),
  authHints: [],
  ipcChannels: new Set(),
};

const files = await fg(['**/*.{js,cjs,mjs,ts,tsx,jsx,html}'], { cwd: UNPACKED, dot: true, absolute: true });

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const urlRe = /(https?:\/\/[^\"'\)\s]+)[\"'\)\s]/g;
  let m;
  while ((m = urlRe.exec(text))) {
    result.endpoints.add(m[1]);
  }
  if (/Authorization|Bearer|token|keytar|electron-store|localStorage|setItem\(|getItem\(/i.test(text)) {
    result.authHints.push(path.relative(UNPACKED, f));
  }
  const ipcRe = /ipc(Main|Renderer)\.(on|invoke|handle)\(['\"]([^'\"]+)/g;
  let n;
  while ((n = ipcRe.exec(text))) {
    result.ipcChannels.add(n[3]);
  }
}

const out = {
  endpoints: Array.from(result.endpoints).sort(),
  authHints: result.authHints.sort(),
  ipcChannels: Array.from(result.ipcChannels).sort(),
};

fs.writeFileSync(path.join(WORKDIR, 'static-analysis.json'), JSON.stringify(out, null, 2));
console.log(chalk.green('[+] static-analysis.json written with:'), out.endpoints.length, 'endpoints,', out.ipcChannels.length, 'ipc channels');


