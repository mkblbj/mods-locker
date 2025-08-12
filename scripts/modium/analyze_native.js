#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const WORKDIR = path.join(ROOT, 'reverse/modium');
const UNPACKED = path.join(WORKDIR, 'unpacked');
if (!fs.existsSync(UNPACKED)) {
  console.error('[!] unpacked not found; run make reverse first');
  process.exit(1);
}

const binFiles = await fg(['**/*.{exe,dll,bin}'], { cwd: UNPACKED, dot: true, absolute: true });
const result = {
  bins: binFiles.map(f => path.relative(UNPACKED, f)),
  urls: new Set(),
  probableRoutes: new Set(),
  keywords: new Set(),
};

const routeRe = /\b(?:game|mod|mods|library|plugin)\/[A-Za-z0-9_\-\/]+/g;
const urlRe = /https?:\/\/[^\s"']+/g;
const keyRe = /(Authorization|Bearer|sqlite|sqlcipher|token|manifest|install|uninstall|enable|disable|mount|unmount|priority|order|db)/ig;

for (const f of binFiles) {
  const out = spawnSync('strings', ['-n', '4', f], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (out.status !== 0) continue;
  const text = out.stdout || '';
  let m;
  while ((m = urlRe.exec(text))) result.urls.add(m[0]);
  while ((m = routeRe.exec(text))) result.probableRoutes.add(m[0]);
  const kw = text.match(keyRe);
  if (kw) kw.forEach(k => result.keywords.add(k));
}

const outJson = {
  bins: result.bins,
  urls: Array.from(result.urls).sort(),
  probableRoutes: Array.from(result.probableRoutes).sort(),
  keywords: Array.from(result.keywords).sort(),
};
fs.writeFileSync(path.join(WORKDIR, 'native-analysis.json'), JSON.stringify(outJson, null, 2));
console.log('[+] native-analysis.json written', { bins: outJson.bins.length, urls: outJson.urls.length, routes: outJson.probableRoutes.length });


