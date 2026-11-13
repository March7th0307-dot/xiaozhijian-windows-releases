'use strict';
// Isolated QA: the controller resolves two private-draft redirects in memory.
// This process receives only short-lived asset URLs over IPC, never an API token.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const {EventEmitter} = require('node:events');
const dir = process.env.WRITER_REPLAY_DIR;
const core = require(path.join(path.dirname(process.execPath), 'resources/app/update-core.js'));
const nativeGet = https.get.bind(https);
const archiveUrl = `https://github.com/${core.REPOSITORY}/releases/download/v1.0.1/xiaozhijian-windows.zip`;
let serial = 0;
const pending = new Map();
process.on('message', msg => {
  if (!msg || msg.type !== 'asset-url' || !pending.has(msg.id)) return;
  const {req,opts,callback} = pending.get(msg.id); pending.delete(msg.id);
  try {
    const url = core.validRemote(msg.url);
    req.inner = nativeGet(url, opts, callback);
    req.inner.on('error', () => req.emit('error', new Error('QA network request failed')));
    if (req.timeout) req.inner.setTimeout(req.timeout.ms, req.timeout.callback);
  } catch (e) { req.emit('error', e); }
});
https.get = (url, opts, callback) => {
  const asset = url.href === core.MANIFEST_URL ? 'manifest' : url.href === archiveUrl ? 'archive' : '';
  if (!asset) return nativeGet(url, opts, callback);
  fs.appendFileSync(path.join(dir,'network-events.txt'),asset+'\n');
  const req = new EventEmitter();
  req.setTimeout = (ms, cb) => { req.timeout={ms,callback:cb}; if (req.inner) req.inner.setTimeout(ms,cb); return req; };
  req.destroy = err => { if (req.inner) req.inner.destroy(err); else if (err) process.nextTick(()=>req.emit('error',err)); return req; };
  const id = ++serial; pending.set(id,{req,opts,callback});
  process.send({type:'asset-request',id,asset});
  return req;
};
const upd = require(path.join(path.dirname(process.execPath), 'resources/app/updater.js'));
let handler;
const win = {isDestroyed:()=>false,webContents:{send:(_ch,txt)=>fs.appendFileSync(path.join(dir,'events.txt'),String(txt)+'\n')},setProgressBar:()=>{}};
const data = path.join(dir,'userdata');
const app = {isPackaged:true,getVersion:()=> '1.0.0',getPath:k=>k==='userData'?data:k==='temp'?require('node:os').tmpdir():path.join(dir,'protected-'+k)};
upd.registerUpdater({app,ipcMain:{handle:(_name,fn)=>handler=fn},BrowserWindow:{},
  dialog:{showMessageBox:async(_win,opts)=>{fs.appendFileSync(path.join(dir,'dialogs.txt'),String(opts.title||opts.message)+'\n');return {response:1};}},
  getMainWindow:()=>win,validMainSender:()=>true,
  requestCloseForUpdate:async launch=>{
    fs.writeFileSync(path.join(data,'draft.txt'),'draft saved before install');
    await launch();fs.writeFileSync(path.join(dir,'handoff.txt'),'ready');
    setTimeout(()=>process.exit(0),300);return true;
  }});
handler({}).catch(e=>{fs.writeFileSync(path.join(dir,'fatal.txt'),String(e.stack||e));process.exit(1);});
