'use strict';
// One-time smoke test. The workflow verifies the candidate hash and executes
// this only on a fresh GitHub-hosted Windows VM. All document data is synthetic.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const exe = process.env.QA_APP_EXE;
const out = process.env.QA_ARTIFACTS;
if (!exe || !out) throw Error('Missing QA paths');
fs.mkdirSync(out, {recursive:true});
const delay = ms => new Promise(r => setTimeout(r, ms));
const safeEnv = {...process.env};
for (const key of Object.keys(safeEnv)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)) delete safeEnv[key];
let child;
function stop() {
  if (!child || !child.pid) return;
  // Kill only this isolated test instance after its explicit successful flush.
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {stdio:'ignore'});
  child = null;
}
async function pageTarget() {
  let last = 'no response';
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch('http://127.0.0.1:9222/json/list', {signal:AbortSignal.timeout(1500)});
      if (response.ok) {
        const list = await response.json();
        const target = list.find(t => t.type === 'page' && t.url.startsWith('writer://app/'));
        if (target && target.webSocketDebuggerUrl) return target;
        last = 'no writer page';
      }
    } catch (error) { last = error.message; }
    if (child.exitCode != null) throw Error('Application exited before page loaded: ' + child.exitCode);
    await delay(500);
  }
  throw Error('No reachable writer page: ' + last);
}
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id=0; this.pending=new Map(); }
  async connect() {
    await new Promise((resolve,reject) => { this.ws.onopen=resolve; this.ws.onerror=reject; });
    this.ws.onmessage = e => {
      const msg=JSON.parse(e.data); if (!msg.id) return;
      const job=this.pending.get(msg.id); if (!job) return; this.pending.delete(msg.id);
      if (msg.error) job.reject(Error(JSON.stringify(msg.error))); else job.resolve(msg.result);
    };
  }
  call(method,params={}) { return new Promise((resolve,reject) => {
    const id=++this.id; this.pending.set(id,{resolve,reject}); this.ws.send(JSON.stringify({id,method,params}));
    setTimeout(() => { if (this.pending.delete(id)) reject(Error('CDP timeout: '+method)); },45000).unref();
  }); }
  async evaluate(fn) {
    const response=await this.call('Runtime.evaluate',{expression:'('+fn.toString()+')()',awaitPromise:true,returnByValue:true});
    if (response.exceptionDetails) throw Error('Page exception: '+JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  close() { this.ws.close(); }
}
async function open() {
  child=spawn(exe,['--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1','--force-renderer-accessibility'],
    {env:safeEnv,stdio:'ignore',windowsHide:false});
  const target=await pageTarget(); const cdp=new CDP(target.webSocketDebuggerUrl); await cdp.connect();
  await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); return cdp;
}
async function snapshot(cdp,name) {
  const png=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  const bytes=Buffer.from(png.data,'base64'); if (bytes.length<1000) throw Error('Screenshot empty: '+name);
  fs.writeFileSync(path.join(out,name),bytes); return bytes.length;
}
async function write() {
  const wait=async(fn,label) => {for(let i=0;i<240;i++){if(fn())return; await new Promise(r=>setTimeout(r,50));}throw Error('timeout: '+label);};
  const el=id=>document.getElementById(id);
  const input=(id,v)=>{const x=el(id);x.value=v;x.dispatchEvent(new Event('input',{bubbles:true}));};
  await wait(()=>el('title') && !el('title').disabled && el('saveStatus').dataset.state==='saved','ready');
  el('newBook').click(); await wait(()=>!el('bookView').hidden && !el('title').disabled,'book');
  input('title','CI Synthetic Book'); el('saveBookMeta').click();
  await wait(()=>el('chapterList').querySelector('button'),'chapter');
  el('chapterList').querySelector('button').click(); await wait(()=>!el('editorView').hidden,'editor');
  const editor=el('editor'); editor.focus(); editor.innerHTML='<p>Synthetic persistence check 4711.</p>';
  editor.dispatchEvent(new Event('input',{bubbles:true}));
  const saved=await window.WriterLifecycle.flushBeforeClose(); if (!saved.ok) throw Error('flush failed');
  return {ok:true,synthetic:true,title:document.title,origin:location.origin,text:editor.textContent};
}
async function read() {
  const wait=async(fn,label) => {for(let i=0;i<240;i++){if(fn())return; await new Promise(r=>setTimeout(r,50));}throw Error('timeout: '+label);};
  const el=id=>document.getElementById(id);
  await wait(()=>document.querySelector('#bookshelf .book-card'),'persisted book');
  const card=[...document.querySelectorAll('#bookshelf .book-card')].find(x=>x.textContent.includes('CI Synthetic Book'));
  if(!card) throw Error('Synthetic book did not persist'); card.click();
  await wait(()=>!el('bookView').hidden && el('chapterList').querySelector('button'),'book view');
  el('chapterList').querySelector('button').click(); await wait(()=>!el('editorView').hidden,'editor view');
  if(!el('editor').textContent.includes('Synthetic persistence check 4711.')) throw Error('Synthetic text did not persist');
  return {ok:true,synthetic:true,titlePersisted:true,textPersisted:true};
}
async function main() {
  let c=await open();
  const info=await c.evaluate(()=>({title:document.title,url:location.href,state:document.readyState}));
  console.log('PAGE',JSON.stringify(info));
  console.log('NATIVE_PROCESS_PID',child.pid);
  const native=spawnSync('powershell.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if($p){$p.Refresh(); @{pid=$p.Id;handle=$p.MainWindowHandle.ToInt64();title=$p.MainWindowTitle}|ConvertTo-Json -Compress}`],{encoding:'utf8'});
  console.log('NATIVE_WINDOW_OBSERVATION',native.stdout.trim() || '(none)');
  const saved=await c.evaluate(write); console.log('WRITE',JSON.stringify(saved));
  console.log('SCREENSHOT_BYTES',await snapshot(c,'synthetic-editor.png'));
  c.close(); stop(); await delay(2000);
  c=await open(); const restored=await c.evaluate(read); console.log('RESTART_READ',JSON.stringify(restored));
  console.log('RESTART_SCREENSHOT_BYTES',await snapshot(c,'synthetic-restored.png'));
  c.close(); stop(); console.log('QA_PASS');
}
main().catch(error=>{console.error('QA_FAIL',error.stack||String(error)); stop();process.exitCode=1;});
