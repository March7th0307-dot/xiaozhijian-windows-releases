'use strict';
// Invoked as Node through the installed Windows Electron executable. All paths
// refer to an isolated GitHub-hosted runner and all writing is synthetic.
const fs=require('fs'),path=require('path');
const dir=process.env.WRITER_REPLAY_DIR;
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
handler({}).catch(e=>{fs.writeFileSync(path.join(dir,'fatal.txt'),String(e.stack||e));process.exit(1);});
