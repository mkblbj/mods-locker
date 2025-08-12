#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import chalk from 'chalk';

const ROOT_DIR = path.resolve(process.cwd());
const WORKDIR = path.join(ROOT_DIR, 'reverse/modium');
const UNPACKED = path.join(WORKDIR, 'unpacked');
const HOOK_PATH = path.join(WORKDIR, 'hook.js');
const STATE = path.join(WORKDIR, 'target.txt');

if (!fs.existsSync(UNPACKED)) {
  console.error(chalk.red('[!] unpacked not found; run make reverse first'));
  process.exit(1);
}

// Write hook.js
const hookCode = `
const fs = require('fs');
const path = require('path');
const electron = require('electron');
const { ipcMain, session, net } = electron;
const LOG = path.join(process.cwd(), 'modium_hook.log');
const log = (...a) => { try { fs.appendFileSync(LOG, a.map(x=> typeof x==='string'?x:JSON.stringify(x)).join(' ') + '\n'); } catch {}
};

try {
  const origRequest = net.request;
  net.request = function(...args){
    log('[net.request]', args);
    const req = origRequest.apply(net, args);
    req.on('response', res=>{
      const chunks=[]; res.on('data', c=>chunks.push(c));
      res.on('end', ()=>{ const body = Buffer.concat(chunks).toString('utf8');
        log('[net.response]', res.statusCode, res.headers, body.slice(0,2000));
      });
    });
    return req;
  };

  const origOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = (ch, listener)=> origOn(ch, (...args)=>{ log('[ipcMain]', ch); listener(...args); });

  electron.app.on('ready', ()=>{
    const filter = { urls: ['http://*/*','https://*/*'] };
    session.defaultSession.webRequest.onBeforeRequest(filter, (details, cb)=>{ log('[webRequest]', details.method, details.url); cb({}); });
  });
} catch(e) { log('[hook error]', e && e.message); }
`;
fs.mkdirSync(WORKDIR, { recursive: true });
fs.writeFileSync(HOOK_PATH, hookCode);

// Find plausible main file(s)
const candidates = await fg(['**/main.js','**/background.js','**/index.js','**/resources/app/main.js'], { cwd: UNPACKED, dot: true, absolute: true });
if (candidates.length === 0) {
  console.error(chalk.yellow('[!] No obvious main.js found; you may need to inject manually.')); 
  process.exit(2);
}

for (const file of candidates) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes("require('./hook')") || src.includes('require("./hook")')) {
    console.log(chalk.gray(`[i] hook already present in ${path.relative(ROOT_DIR, file)}`));
    continue;
  }
  const injected = `require('${path.relative(path.dirname(file), HOOK_PATH).replace(/\\/g,'/')}');\n` + src;
  fs.writeFileSync(file, injected);
  console.log(chalk.green('[+] injected hook into ' + path.relative(ROOT_DIR, file)));
}

console.log(chalk.green('[✓] hook ready. Run make repack to rebuild asar.'))


