'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'writer-windows-update-qa-'));
const base=process.env.QA_REPLAY_BASE;
if(!base)throw Error('Missing replay artifacts');
const archive=path.join(base,'xiaozhijian-windows.zip');
const harness=path.resolve('qa/update-replay-harness.js');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const expect=(value,message)=>{if(!value)throw Error(message);};
async function waitFor(fn,label,ms=180000){const end=Date.now()+ms;while(Date.now()<end){const result=fn();if(result)return result;await delay(300);}throw Error('Timeout: '+label);}
function makeCase(name){
  const dir=path.join(root,name),install=path.join(dir,'install'),data=path.join(dir,'userdata');
  fs.mkdirSync(install,{recursive:true});fs.mkdirSync(data,{recursive:true});
  const result=spawnSync('tar.exe',['-xf',archive,'-C',install,'--strip-components=1'],{encoding:'utf8'});
  expect(result.status===0,'Failed to extract isolated candidate: '+result.stderr);
  fs.writeFileSync(path.join(data,'draft.txt'),'original synthetic draft');
  fs.writeFileSync(path.join(install,'personal-notes.txt'),'synthetic extra file survives');
  const pkg=path.join(install,'resources/app/package.json');
  const obj=JSON.parse(fs.readFileSync(pkg,'utf8'));obj.version='1.0.0';
  fs.writeFileSync(pkg,JSON.stringify(obj));
  const inventoryPath=path.join(install,'.xiaozhijian-files.json');
  const inventory=JSON.parse(fs.readFileSync(inventoryPath,'utf8'));
  inventory.files['resources/app/package.json']=hash(fs.readFileSync(pkg));
  fs.writeFileSync(inventoryPath,JSON.stringify(inventory));
  return {dir,install,data,pkg,exe:path.join(install,'Xiaozhijian.exe')};
}
async function launch(c,fail){
  const env={...process.env};for(const key of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key))delete env[key];
  env.ELECTRON_RUN_AS_NODE='1';env.WRITER_REPLAY_DIR=c.dir;env.WRITER_REPLAY_BASE=base;env.WRITER_REPLAY_FAIL=fail?'1':'0';
  env.APPDATA=path.join(c.dir,'appdata');fs.mkdirSync(env.APPDATA,{recursive:true});
  const log=fs.openSync(path.join(c.dir,'harness.log'),'w');
  const child=spawn(c.exe,[harness],{env,stdio:['ignore',log,log],windowsHide:true});fs.closeSync(log);
  let ended=false,code=null;child.on('exit',value=>{ended=true;code=value;});
  await waitFor(()=>ended,'updater parent exit');
  if(code!==0){const output=fs.readFileSync(path.join(c.dir,'harness.log'),'utf8');throw Error('Updater parent exit '+code+': '+output.slice(-4000));}
}
async function testRejected(){
  const c=makeCase('invalid-signature');await launch(c,true);
  expect(fs.existsSync(path.join(c.dir,'done.txt')),'Missing rejection marker');
  expect(fs.readFileSync(path.join(c.data,'draft.txt'),'utf8')==='original synthetic draft','Rejected update changed draft');
  expect(JSON.parse(fs.readFileSync(c.pkg,'utf8')).version==='1.0.0','Rejected update changed version');
  expect(fs.readFileSync(path.join(c.install,'personal-notes.txt'),'utf8')==='synthetic extra file survives','Rejected update changed extra file');
  expect(!fs.existsSync(path.join(c.install,'.xiaozhijian-update.lock')),'Rejected update left lock');
  expect(fs.readFileSync(path.join(c.dir,'events.txt'),'utf8').includes('更新未完成'),'Rejection did not report failure');
  console.log('INVALID_SIGNATURE_REJECTED old_version_and_synthetic_files_preserved');
}
function findRunning(exe){
  const env={...process.env,WRITER_EXPECTED_EXE:exe};for(const k of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(k))delete env[k];
  const command="$p=Get-Process -Name Xiaozhijian -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $env:WRITER_EXPECTED_EXE} | Select-Object -First 1; if($p){$p.Refresh(); Write-Output ($p.Id.ToString()+':'+$p.MainWindowHandle.ToInt64())}";
  const r=spawnSync('powershell.exe',['-NoProfile','-Command',command],{env,encoding:'utf8'});
  const line=r.stdout.trim();return /^\d+:\d+$/.test(line)?line:null;
}
async function testUpdate(){
  const c=makeCase('signed-update');await launch(c,false);
  expect(fs.existsSync(path.join(c.dir,'handoff.txt')),'Helper did not signal handoff');
  const statusPath=path.join(c.data,'.xiaozhijian-update-result.json');
  await waitFor(()=>fs.existsSync(statusPath),'helper completion');
  const status=JSON.parse(fs.readFileSync(statusPath,'utf8'));
  expect(status.status==='success','Helper failed: '+status.message);
  expect(JSON.parse(fs.readFileSync(c.pkg,'utf8')).version==='1.0.1','Updated version missing');
  expect(fs.readFileSync(path.join(c.data,'draft.txt'),'utf8')==='draft saved before install','Synthetic draft changed');
  expect(fs.readFileSync(path.join(c.install,'personal-notes.txt'),'utf8')==='synthetic extra file survives','Extra file changed');
  expect(!fs.existsSync(path.join(c.install,'.xiaozhijian-update.lock')),'Successful update left lock');
  const observed=await waitFor(()=>findRunning(c.exe),'relaunch process',60000);
  const [pid,handle]=observed.split(':').map(Number);expect(pid>0,'Invalid relaunch pid');
  console.log('SIGNED_UPDATE_PASS installed_version=1.0.1 synthetic_draft_and_extra_file_preserved relaunch_pid='+pid+' initial_window_handle='+handle);
  spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{stdio:'ignore'});
}
(async()=>{await testRejected();await testUpdate();console.log('WINDOWS_UPDATE_REPLAY_PASS');})()
  .catch(error=>{console.error('WINDOWS_UPDATE_REPLAY_FAIL',error.stack||String(error));process.exitCode=1;});
