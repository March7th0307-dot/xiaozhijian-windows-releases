'use strict';
// Invoked as Node through the installed Windows Electron executable. All paths
// refer to an isolated GitHub-hosted runner and all writing is synthetic.
const fs=require('fs'),path=require('path'),https=require('https');
const {EventEmitter}=require('events'),{Readable}=require('stream');
const dir=process.env.WRITER_REPLAY_DIR, base=process.env.WRITER_REPLAY_BASE;
const fail=process.env.WRITER_REPLAY_FAIL==='1';
const core=require(path.join(path.dirname(process.execPath),'resources/app/update-core.js'));
https.get=(url,opts,callback)=>{
  const req=new EventEmitter();req.setTimeout=()=>req;
  process.nextTick(()=>{
    let res;
    if(url.href===core.MANIFEST_URL){
      const data=JSON.parse(fs.readFileSync(path.join(base,'update.json'),'utf8'));
      if(fail)data.sha256='0'.repeat(64);
      res=Readable.from([Buffer.from(JSON.stringify(data))]);
    }else res=fs.createReadStream(path.join(base,'xiaozhijian-windows.zip'));
    res.statusCode=200;res.headers={};callback(res);
  });return req;
};
const upd=require(path.join(path.dirname(process.execPath),'resources/app/updater.js'));
let handler;
const win={isDestroyed:()=>false,webContents:{send:(_ch,txt)=>fs.appendFileSync(path.join(dir,'events.txt'),String(txt)+'\n')},setProgressBar:()=>{}};
const data=path.join(dir,'userdata');
const app={isPackaged:true,getVersion:()=> '1.0.0',getPath:k=>k==='userData'?data:k==='temp'?require('os').tmpdir():path.join(dir,'protected-'+k)};
upd.registerUpdater({app,ipcMain:{handle:(_name,fn)=>handler=fn},BrowserWindow:{},
  dialog:{showMessageBox:async(_win,opts)=>{fs.appendFileSync(path.join(dir,'dialogs.txt'),String(opts.title||opts.message)+'\n');return {response:1};}},
  getMainWindow:()=>win,validMainSender:()=>true,
  requestCloseForUpdate:async launch=>{
    fs.writeFileSync(path.join(data,'draft.txt'),'draft saved before install');
    await launch();fs.writeFileSync(path.join(dir,'handoff.txt'),'ready');
    setTimeout(()=>process.exit(0),300);return true;
  }});
handler({}).then(()=>{if(fail){fs.writeFileSync(path.join(dir,'done.txt'),'error-branch');process.exit(0);}})
  .catch(e=>{fs.writeFileSync(path.join(dir,'fatal.txt'),String(e.stack||e));process.exit(1);});
