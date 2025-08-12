#!/usr/bin/env node
// Cross-platform CLI to automate Tauri IPC: enable/disable mods via DevTools.
// Features:
// - Attach to existing WebView2 debugging port or launch helper .bat
// - Inject JS: generate legal Tauri callback ids, call set_disabled, apply changes, optional UI refresh
// - Batch operations: --mods 1,2,3 --disable/--enable

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import CDP from 'chrome-remote-interface';

const argv = yargs(hideBin(process.argv))
  .option('port', { describe: 'WebView2 debug port (auto to detect)', default: 'auto', type: 'string' })
  .option('host', { describe: 'DevTools host', default: '127.0.0.1', type: 'string' })
  .option('game', { describe: 'gameId', default: 1, type: 'number' })
  .option('mods', { describe: 'comma separated modIds', type: 'string' })
  .option('disable', { describe: 'disable mods', type: 'boolean' })
  .option('enable', { describe: 'enable mods', type: 'boolean' })
  .option('list', { describe: 'list installed mods (prints JSON)', type: 'boolean' })
  .option('out', { describe: 'output file for list JSON', type: 'string' })
  .option('sniff-remote', { describe: 'sniff remote HTTP(S) requests (exclude ipc.localhost)', type: 'boolean' })
  .option('sniff-seconds', { describe: 'sniff duration in seconds', default: 15, type: 'number' })
  .option('sniff-out', { describe: 'output file for sniffed requests JSON', type: 'string' })
  .option('refresh', { describe: 'try to refresh UI after actions', default: true, type: 'boolean' })
  .check(args => {
    if (args.list || args['sniff-remote']) return true;
    if (!args.mods) throw new Error('Provide --mods for enable/disable OR use --list');
    if (!(args.disable ^ args.enable)) throw new Error('Specify exactly one of --disable or --enable');
    return true;
  })
  .help().argv;

const mods = (argv.mods || '').split(',').map(s => Number(s.trim())).filter(Boolean);
const desiredDisabled = argv.disable ? true : false;

async function detectPort(host) {
  const ports = [9555, 9666, 9222, 9333, 9777];
  for (const p of ports) {
    try { const res = await fetch(`http://${host}:${p}/json/version`, { timeout: 1000 }); if (res.ok) return p; } catch {}
  }
  throw new Error('No DevTools endpoint detected. Start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<PORT>');
}

async function pickTarget(host, port) {
  const list = await (await fetch(`http://${host}:${port}/json/list`)).json();
  // prefer tauri://localhost pages
  let target = list.find(t => (t.url||'').startsWith('tauri://localhost')) || list.find(t => (t.type==='page')) || list[0];
  if (!target) throw new Error('No page target found');
  return target;
}

async function main() {
  const host = argv.host;
  const port = argv.port === 'auto' ? await detectPort(host) : Number(argv.port);
  console.log(`[+] Using DevTools at http://${host}:${port}`);
  const target = await pickTarget(host, port);
  console.log(`[+] Attaching to target: ${target.title} ${target.url}`);

  const client = await CDP({ host, port, target: target.id });
  const { Runtime, Page, Network } = client;
  await Runtime.enable();
  await Page.enable();
  await Network.enable();

  // Capture tauri-invoke-key from any real network request headers (Node-side via CDP)
  let tauriKeyFromNetwork = null;
  const tryCaptureFromHeaders = (headers) => {
    if (!headers) return;
    try {
      for (const k of Object.keys(headers)) {
        const v = headers[k];
        if (String(k).toLowerCase().includes('tauri-invoke-key') && v) {
          tauriKeyFromNetwork = String(v);
          break;
        }
      }
    } catch {}
  };
  Network.requestWillBeSent((params)=>{ tryCaptureFromHeaders(params.request?.headers||{}); });
  Network.requestWillBeSentExtraInfo((params)=>{ tryCaptureFromHeaders(params.headers||{}); });
  Network.responseReceivedExtraInfo((params)=>{ tryCaptureFromHeaders(params.headers||{}); });

  // Helper to eval in page and return value
  async function evalInPage(expression) {
    const r = await Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'Eval error');
    return r.result.value;
  }

  // Inject bootstrap: capture key, register senders, relaxed collector and list helper
  const bootstrap = `
(function(){
  window.__mods_cli_log = [];
  // capture latest invoke key
  (function(){
    const save = (k, v)=>{ if(!v) return; if(k.toLowerCase().includes('tauri-invoke-key')) { window.__TAURI_INVOKE_KEY__ = v; } };
    const ap=Headers.prototype.append, st=Headers.prototype.set;
    if(!window.__mods_cli_hooked){
      Headers.prototype.append=function(k,v){ save(k,v); return ap.call(this,k,v); };
      Headers.prototype.set=function(k,v){ save(k,v); return st.call(this,k,v); };
      window.__mods_cli_hooked=true;
    }
  })();

  // register global callback ids as Tauri expects
  window.__mkHandlers = function(){
    const mk=()=>String((Date.now()%1e9)+Math.floor(Math.random()*1e6));
    const cb=mk(), err=mk();
    const done = new Promise((resolve,reject)=>{ window['_'+cb]=(v)=>{ try{resolve(v);}finally{delete window['_'+cb]; delete window['_'+err];}}; window['_'+err]=(e)=>{ try{reject(e);}finally{delete window['_'+cb]; delete window['_'+err];}}; });
    return {cb,err,done};
  };

  window.__tauriSend = async function(endpoint, body){
    const key = window.__TAURI_INVOKE_KEY__;
    if(!key) throw new Error('no tauri key');
    const {cb,err,done} = window.__mkHandlers();
    const msg = JSON.stringify({ endpoint, requestId: (crypto.randomUUID?.()||String(Date.now())), body });
    await fetch('http://ipc.localhost/post_msg_to_backend', { method:'POST', headers:{ 'content-type':'application/json', 'tauri-invoke-key': key, 'tauri-callback': cb, 'tauri-error': err }, body: JSON.stringify({ msg }) });
    return await done.catch(e=>({error:e}));
  };

  // Some endpoints (like installed_mods) stream via plugin:// and never resolve the callback.
  // Provide a quick, timeout-raced variant so callers never hang the DevTools evaluation.
  window.__tauriSendQuick = async function(endpoint, body, timeoutMs){
    const ms = Number(timeoutMs ?? 800);
    try {
      const p = window.__tauriSend(endpoint, body);
      const t = new Promise(resolve => setTimeout(() => resolve('__timeout__'), ms));
      const r = await Promise.race([p, t]);
      return r === '__timeout__' ? null : r;
    } catch (e) {
      return null;
    }
  };

  window.__setDisabledReal = async function(modId, disabled, gameId){ return await window.__tauriSend('mod/set_disabled', { gameId, modId, disabled }); };
  window.__applyChanges = async function(gameId){ try{ await window.__tauriSend('mod/update_modded_files', { gameId }); }catch(e){} try{ await window.__tauriSend('game/sync_status', { gameId }); }catch(e){} };
  // relaxed collector
  (function(){
    const S = window.__mods_relax = { buf:'', list:[], seen:new Set(), hits:0 };
    const scrub = (t)=> (t||'').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]+/g,'');
    const parse = (txt)=>{ if(!txt||!/"records"/.test(txt)) return null; txt=scrub(txt); const s=txt.indexOf('{"code":'); const e=txt.lastIndexOf('}'); if(s===-1||e===-1||e<=s) return null; let sl=txt.slice(s,e+1); try{return JSON.parse(sl);}catch{} for(let i=1;i<=3;i++){ try{return JSON.parse(sl+'}'.repeat(i));}catch{} } return null; };
    const merge=(arr)=>{ for(const m of (arr||[])){ const id=m.id??m.modId??m.mod_id; if(id&&!S.seen.has(id)){ S.seen.add(id); S.list.push(m);} } };
    const onChunk=(url,raw)=>{ if(!raw||raw==='null'||raw==='undefined') return; S.buf+=raw; const obj=parse(S.buf)||parse(raw); if(obj){ const arr=obj?.data?.records||obj?.records||obj?.list||obj?.items||[]; merge(arr); S.hits++; S.buf=''; } };
    const _f=window.fetch; window.fetch=async (...a)=>{ const r=await _f(...a); try{ const t=await r.clone().text(); const u=String(a[0]||''); if(u.includes('plugin%3A')||/"records"/.test(t)) onChunk(u,t);}catch{} return r; };
    const _o=XMLHttpRequest.prototype.open, _s=XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.open=function(m,u,...r){ this.__url=String(u||''); return _o.call(this,m,u,...r); }; XMLHttpRequest.prototype.send=function(b){ this.addEventListener('load', function(){ try{ onChunk(this.__url||'xhr', this.responseText);}catch{} }); return _s.call(this,b); };
  })();
  // list helper
  window.__listInstalled = async function(gameId,pageSize){
    // Try direct callback path first, but never hang
    try{
      const r = await window.__tauriSendQuick('mod/installed_mods', {gameId,current:1,size:pageSize,sort:'priority:desc,installed_at:desc'}, 800);
      const arr = (r?.data?.list||r?.list||r?.items)||[];
      if(Array.isArray(arr) && arr.length) return arr;
    }catch(e){}

    // Fire-and-forget trigger + wait for relax collector
    const b = window.__mods_relax.hits;
    // try to simulate the UI refresh that user manually clicks
    try{ if(window.__tryClickRefresh) await window.__tryClickRefresh(); }catch(e){}
    try{ void window.__tauriSendQuick('mod/installed_mods', {gameId,current:1,size:pageSize,sort:'priority:desc,installed_at:desc'}, 300); }catch(e){}
    const deadline = Date.now()+7000;
    while(window.__mods_relax.hits===b && Date.now()<deadline){ await new Promise(r=>setTimeout(r,200)); }
    if((window.__mods_relax.list||[]).length) return window.__mods_relax.list;

    // Fallback path
    try{
      const r2 = await window.__tauriSendQuick('mod/installed_mods_for_priority', {gameId}, 800);
      const arr2 = (r2?.data?.list||r2?.list||r2?.items)||[];
      if(Array.isArray(arr2) && arr2.length) return arr2;
    }catch(e){}
    const b2 = window.__mods_relax.hits;
    try{ void window.__tauriSendQuick('mod/installed_mods_for_priority', {gameId}, 300); }catch(e){}
    const deadline2 = Date.now()+7000;
    while(window.__mods_relax.hits===b2 && Date.now()<deadline2){ await new Promise(r=>setTimeout(r,200)); }
    return window.__mods_relax.list||[];
  };

  // ensure tauri key without relying on raw fetch (which lacks header injection)
  window.__ensureKey = async function(){
    const has = ()=> Boolean(window.__TAURI_INVOKE_KEY__);
    if (has()) return true;
    // click refresh upfront to trigger any request with headers
    try{ if(window.__tryClickRefresh) await window.__tryClickRefresh(); }catch{}
    // Prefer using tauri core.invoke to auto-attach headers
    for (let i=0; i<5 && !has(); i++) {
      try { if (window.__TAURI__?.core?.invoke) { await window.__TAURI__.core.invoke('plugin:window|start_dragging', {}); } } catch {}
      await new Promise(r=>setTimeout(r,200));
    }
    if (has()) return true;
    // Gentle UI nudge to produce any IPC
    try {
      const clickByText=(re)=>{ const el=[...document.querySelectorAll('a,button,[role],div,span')].find(e=>re.test((e.innerText||e.textContent||'').trim())); if(el){ el.click(); return true;} return false; };
      clickByText(/模组库|模組庫|Mods|库/);
      await new Promise(r=>setTimeout(r,400));
    } catch {}
    return has();
  };

  // best-effort click of page refresh control (text/title/aria-label contains 刷新/Refresh)
  window.__tryClickRefresh = async function(){
    const qs = 'a,button,[role="button"],div,span';
    const cand = [...document.querySelectorAll(qs)].filter(e=>{
      const t=(e.innerText||e.textContent||'').trim();
      const title=e.getAttribute?.('title')||'';
      const aria=e.getAttribute?.('aria-label')||'';
      return /刷新|Refresh|更新/.test(t)||/刷新|Refresh|更新/.test(title)||/刷新|Refresh|更新/.test(aria);
    });
    if(cand.length){ cand[0].click(); await new Promise(r=>setTimeout(r,200)); }
  };
})();
  `;
  async function __inject(){
    return await evalInPage(bootstrap);
  }
  await __inject();

  // Function: push captured key into the page once we see it via CDP
  async function pushKeyIntoPageIfAny(){
    if (!tauriKeyFromNetwork) return false;
    try { await evalInPage(`window.__TAURI_INVOKE_KEY__=${JSON.stringify(tauriKeyFromNetwork)}`); return true; } catch { return false; }
  }

  // Nudge UI navigation to trigger at least one real IPC (so CDP can see headers)
  try {
    await evalInPage(`(async()=>{ const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const click=(t)=>{ const n=[...document.querySelectorAll('a,button,[role],div,span')].find(e=>(e.innerText||e.textContent||'').includes(t)); if(n){n.click(); return true;} return false; }; if(click('首页')){ await sleep(150); click('模组库'); } else { click('模组库')||click('Mods'); } })()`);
  } catch {}

  // Ensure tauri invoke key is captured (without causing 500)
  try { await evalInPage(`window.__ensureKey && window.__ensureKey()`); } catch {}

  // Wait briefly for CDP to see a request and push key into page
  const keyWaitDeadline = Date.now()+2000;
  while (Date.now() < keyWaitDeadline) {
    if (await pushKeyIntoPageIfAny()) break;
    await new Promise(r=>setTimeout(r,100));
  }

  if (argv['sniff-remote']) {
    const startTs = Date.now();
    const cut = (s,l=200)=>{ s=String(s||''); return s.length>l? s.slice(0,l)+'…' : s; };
    const isLocal = (u)=>/ipc\.localhost|plugin%3A|tauri:\/\//i.test(u||'') || /^data:|^chrome:|^devtools:/i.test(u||'');
    const store = new Map(); // id -> partial
    const out = [];

    Network.requestWillBeSent(params => {
      const { requestId, request } = params;
      const url = String(request?.url || '');
      if (isLocal(url)) return;
      store.set(requestId, {
        id: requestId,
        ts: Date.now(),
        method: request?.method,
        url,
        requestHeaders: request?.headers || {},
      });
    });
    Network.responseReceived(params => {
      const it = store.get(params.requestId); if (!it) return;
      it.status = params.response?.status;
      it.responseHeaders = params.response?.headers || {};
      it.mimeType = params.response?.mimeType;
    });
    Network.loadingFinished(async params => {
      const it = store.get(params.requestId); if (!it) return;
      try {
        const body = await Network.getResponseBody({ requestId: params.requestId }).catch(()=>null);
        if (body && body.body) {
          const text = body.base64Encoded ? Buffer.from(body.body,'base64').toString('utf8') : body.body;
          // only keep small-ish JSON bodies to avoid huge logs
          if ((it.mimeType||'').includes('json') && text && text.length <= 200000) {
            it.responseBodyPreview = cut(text, 10000);
          }
        }
      } catch {}
      out.push(it);
      store.delete(params.requestId);
    });

    // gentle UI nudge to trigger requests
    try {
      await evalInPage(`(async()=>{ const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const click=(t)=>{ const n=[...document.querySelectorAll('a,button,[role],div,span')].find(e=>(e.innerText||e.textContent||'').includes(t)); if(n){n.click(); return true;} return false; }; if(click('首页')){ await sleep(120); click('模组库'); } else { click('模组库')||click('Mods'); } })()`);
    } catch {}

    const until = Date.now() + Math.max(1, Number(argv['sniff-seconds']))*1000;
    while (Date.now() < until) { await new Promise(r=>setTimeout(r,200)); }

    // finalize
    const result = out.sort((a,b)=>a.ts-b.ts);
    if (argv['sniff-out']) {
      const p = path.resolve(argv['sniff-out']);
      fs.writeFileSync(p, JSON.stringify(result, null, 2));
      console.log(`[✓] sniffed ${result.length} requests -> ${p}`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } else if (argv.list) {
    let listJson = await evalInPage(`(async()=>{ const l=await window.__listInstalled(${argv.game},200); return JSON.stringify(l); })()`);
    let list = JSON.parse(listJson || '[]');
    // If first attempt yields empty, nudge UI and retry once (no hard reload to avoid breaking Tauri IPC)
    if (!Array.isArray(list) || list.length === 0) {
      try { await evalInPage(`window.__tryClickRefresh && window.__tryClickRefresh()`); } catch {}
      try { await evalInPage(`window.__ensureKey && window.__ensureKey()`); } catch {}
      listJson = await evalInPage(`(async()=>{ const l=await window.__listInstalled(${argv.game},200); return JSON.stringify(l); })()`);
      list = JSON.parse(listJson || '[]');
    }
    if (argv.out) {
      const outPath = path.resolve(argv.out);
      fs.writeFileSync(outPath, JSON.stringify(list, null, 2));
      console.log(`[✓] wrote ${list.length} items to ${outPath}`);
    } else {
      console.log(JSON.stringify(list, null, 2));
    }
  } else {
    for (const modId of mods) {
      console.log(`[+] set_disabled mod=${modId} disabled=${desiredDisabled}`);
      await evalInPage(`window.__setDisabledReal(${modId}, ${desiredDisabled}, ${argv.game})`);
    }
    console.log('[+] applying changes');
    await evalInPage(`window.__applyChanges(${argv.game})`);

    if (argv.refresh) {
      try {
        await evalInPage(`(async()=>{ const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const click=(t)=>{ const n=[...document.querySelectorAll('a,button,[role],div,span')].find(e=>(e.innerText||e.textContent||'').includes(t)); if(n){n.click(); return true;} return false; }; if(click('首页')){ await sleep(180); click('模组库'); } else if(!click('模组库')) { location.reload(); } })()`);
        console.log('[+] refresh attempted');
      } catch { console.log('[!] refresh skipped'); }
    }
  }

  await client.close();
  console.log('[✓] done');
}

main().catch(e => { console.error('[ERR]', e.message || e); process.exit(1); });


