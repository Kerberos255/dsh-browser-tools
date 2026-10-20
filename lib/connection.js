import { chromium } from 'playwright-core';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** True when the DevTools endpoint answers like a real CDP server. */
async function probeCdp(endpoint){
 const origin=endpoint.protocol==='ws:'?'http://'+endpoint.host:endpoint.protocol==='wss:'?'https://'+endpoint.host:endpoint.origin;
 try{
  const response=await fetch(origin+'/json/version',{signal:AbortSignal.timeout(1200)});
  if(!response.ok)return false;
  const body=await response.json().catch(()=>null);
  return Boolean(body&&typeof body==='object'&&(body.Browser!==undefined||body.webSocketDebuggerUrl!==undefined));
 }catch{return false;}
}
/** Chrome launch arguments for the configured CDP endpoint. */
function launchArguments(config,endpoint){
 const args=['--remote-debugging-address='+endpoint.hostname.replace(/^\[|\]$/g,''),'--remote-debugging-port='+(endpoint.port||'80')];
 const profile=String(config.launchUserDataDir??'').trim();
 if(profile)args.push('--user-data-dir='+profile);
 let extra=[];
 try{extra=JSON.parse(config.launchArgsJson??'[]');}catch{extra=[];}
 for(const value of Array.isArray(extra)?extra:[])if(typeof value==='string'&&value.trim())args.push(value);
 args.push('--no-first-run','--no-default-browser-check');
 return args;
}
function killProcessTree(pid){return new Promise(resolve=>execFile('taskkill',['/PID',String(pid),'/T','/F'],()=>resolve()));}

export class BrowserFailure extends Error{constructor(code,message,details={}){super(message);this.name='BrowserFailure';this.code=code;this.details=details;}}
export function cancellable(promise,signal,late){
 if(signal.aborted){Promise.resolve(promise).then(late??(()=>{}),()=>{});return Promise.reject(signal.reason);}
 return new Promise((resolve,reject)=>{let aborted=false;const stop=()=>{aborted=true;reject(signal.reason);};signal.addEventListener('abort',stop,{once:true});Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',stop);if(aborted)late?.(value);else resolve(value);},error=>{signal.removeEventListener('abort',stop);if(!aborted)reject(error);});});
}
 export class Connection {
 constructor(config,{connect=(url,options)=>chromium.connectOverCDP(url,options),artifactsDir,spawnProcess=(file,args,options)=>spawn(file,args,options),probe=probeCdp,now=()=>Date.now(),schedule=(run,ms)=>{const timer=setTimeout(run,ms);timer.unref?.();return timer;},cancel=timer=>clearTimeout(timer),kill=killProcessTree}={}){this.config=config;this.connect=connect;this.artifactsDir=artifactsDir;this.spawnProcess=spawnProcess;this.probe=probe;this.now=now;this.schedule=schedule;this.cancel=cancel;this.kill=kill;this.browser=null;this.connecting=null;this.selecting=Promise.resolve();this.states=new Map();this.claims=new Map();this.targets=new Map();this.pageTargets=new WeakMap();this.closed=false;this.generation=0;this.launching=null;this.launchProcess=null;this.launchOwned=false;this.launchFailure=null;this.idleTimer=null;this.idleMinutes=0;this.lastActivityAt=null;}
 state(id){let state=this.states.get(id);if(!state){state={id,run:randomUUID(),refPrefix:randomUUID().slice(0,8),counter:0,epoch:0,refs:new Map(),secretNodes:new WeakMap(),page:null,cdp:null,tail:Promise.resolve(),abort:new AbortController(),owned:new Set(),pageHooks:new Map(),released:false};this.states.set(id,state);}return state;}
 invalidate(state){state.epoch++;state.refs.clear();}
 async ready(signal){
  signal.throwIfAborted();if(this.closed)throw new BrowserFailure('browser-unavailable','浏览器插件已卸载');
  if(this.browser?.isConnected()){this.touch();return this.browser;}
  if(!this.connecting){
   const generation=this.generation;
   this.connecting=(async()=>{
    const config=this.config(),artifactsDir=await this.artifactsDir?.();
    const connect=()=>this.connect(config.cdpUrl,{timeout:config.actionTimeoutMs,noDefaults:true,...artifactsDir?{artifactsDir}: {}});
    let browser;
    try{browser=await connect();}
    catch(connectError){
     if(!config.launch)throw connectError;
     try{await this.ensureLaunched(config);}
     catch(launchError){this.launchFailure=String(launchError?.message??launchError);throw connectError;}
     browser=await connect();
    }
    if(this.closed||generation!==this.generation){await browser.close();throw new BrowserFailure('browser-unavailable','浏览器设置已更新，请重新调用');}
    this.browser=browser;browser.on('disconnected',()=>{if(this.browser===browser){this.browser=null;for(const state of this.states.values()){state.cdp=null;this.invalidate(state);}}});
    // Recover ownership of still-open targets after a transport disconnect.
    if(this.targets.size)for(const page of browser.contexts()[0]?.pages()??[]){let session;try{session=await page.context().newCDPSession(page);const {targetInfo}=await session.send('Target.getTargetInfo');const owner=this.targets.get(targetInfo?.targetId),state=owner&&this.states.get(owner.id);if(state){this.pageTargets.set(page,targetInfo.targetId);if(owner.owned)state.owned.add(page);this.claims.set(page,state.id);if(state.currentTarget===targetInfo.targetId)this.watch(state,page,owner.owned);}}catch{}finally{await session?.detach().catch(()=>{});}}
    this.touch();this.armIdleExit();
    return browser;
   })().catch(error=>{throw error instanceof BrowserFailure?error:this.unavailable();}).finally(()=>{this.connecting=null;});
  }
  return cancellable(this.connecting,signal);
 }
 /** Connection failure message: manual command when launching is off, launch detail when it failed. */
 unavailable(){
  const config=this.config(),endpoint=new URL(config.cdpUrl);
  const port=endpoint.port||(['https:','wss:'].includes(endpoint.protocol)?'443':'80');
  const address=endpoint.hostname.replace(/^\[|\]$/g,'');
  const command='chrome.exe --remote-debugging-address='+address+' --remote-debugging-port='+port+' --user-data-dir=浏览器配置目录';
  if(config.launch)return new BrowserFailure('browser-unavailable','无法连接浏览器 '+endpoint.origin+'，自动启动也未成功（'+(this.launchFailure??'launch-failed')+'）。请检查「自动启动浏览器」「浏览器可执行文件路径」「浏览器配置目录」设置，或手动启动：'+command);
  return new BrowserFailure('browser-unavailable','无法连接浏览器 '+endpoint.origin+'。请用户手动启动 CloakBrowser，或在设置中开启「自动启动浏览器」；命令示例：'+command+'。完整路径与配置目录见插件 README。');
 }
 touch(){this.lastActivityAt=this.now();}
 /** Start the configured browser once, reusing any instance already listening on the endpoint. */
 async ensureLaunched(config){
  if(this.launching)return this.launching;
  this.launching=(async()=>{
   const endpoint=new URL(config.cdpUrl);
   if(await this.probe(endpoint))return;
   const executable=String(config.launchExecutablePath??'').trim();
   if(!executable)throw new Error('launch-executable-missing');
   const child=this.spawnProcess(executable,launchArguments(config,endpoint),{detached:true,stdio:'ignore',windowsHide:true});
   child?.unref?.();
   this.launchProcess=child??null;this.launchOwned=true;this.touch();
   const timeout=Math.max(2000,Number(config.launchTimeoutMs)||20000),deadline=this.now()+timeout;
   for(;;){
    if(await this.probe(endpoint))return;
    if(child&&child.exitCode!==void 0&&child.exitCode!==null)throw new Error('launch-exited:'+child.exitCode);
    if(this.closed)throw new Error('launch-aborted');
    if(this.now()>=deadline)throw new Error('launch-timeout');
    await new Promise(resolve=>this.schedule(resolve,250));
   }
  })().finally(()=>{this.launching=null;});
  return this.launching;
 }
 /** Arm the idle check for an instance this plugin started (0 minutes disables it). */
 armIdleExit(){
  const minutes=Number(this.config().idleExitMinutes??30);
  if(!this.launchOwned||this.idleTimer||this.closed||!Number.isFinite(minutes)||minutes<=0)return;
  this.idleMinutes=minutes;
  this.lastActivityAt??=this.now();
  this.idleTimer=this.schedule(()=>this.idleCheck(),Math.min(minutes*60000,60000));
 }
 idleCheck(){
  this.idleTimer=null;
  if(this.closed||!this.launchOwned)return;
  if(this.now()-(this.lastActivityAt??this.now())>=this.idleMinutes*60000){void this.exitIdle();return;}
  this.armIdleExit();
 }
 /** Close an idle browser this plugin started; a user-started instance is never touched. */
 async exitIdle(){
  const child=this.launchProcess;
  this.launchOwned=false;this.launchProcess=null;
  if(this.idleTimer){this.cancel(this.idleTimer);this.idleTimer=null;}
  await this.reset().catch(()=>{});
  if(child?.pid)await this.kill(child.pid).catch(()=>{});
 }
 watch(state,page,owned=false){
  if(owned)state.owned.add(page);this.claims.set(page,state.id);state.page=page;this.invalidate(state);
  if(state.pageHooks.has(page))return;
  const navigation=frame=>{if(frame===page.mainFrame())this.invalidate(state);};
  const closed=()=>{this.claims.delete(page);state.owned.delete(page);page.off('framenavigated',navigation);page.off('close',closed);state.pageHooks.delete(page);const target=this.pageTargets.get(page);if(this.browser?.isConnected()&&target)this.targets.delete(target);this.invalidate(state);if(state.page===page){state.page=null;state.cdp=null;}};
  page.on('framenavigated',navigation);page.on('close',closed);state.pageHooks.set(page,{navigation,closed});
 }
 async page(state,signal,{create=false,newTab=false}={}){
  const browser=await this.ready(signal);signal.throwIfAborted();
  if(state.released)throw new BrowserFailure('browser-unavailable','此会话的浏览器已释放');
  if(state.page&&!state.page.isClosed()&&!newTab)return state.page;
  const pending=this.selecting.catch(()=>{}).then(()=>this.selectPage(browser,state,signal,{create,newTab}));this.selecting=pending.then(()=>{},()=>{});return pending;
 }
 async selectPage(browser,state,signal,{create,newTab}){
  signal.throwIfAborted();if(state.released)throw new BrowserFailure('browser-unavailable','此会话的浏览器已释放');
  const context=browser.contexts()[0];if(!context)throw new BrowserFailure('page-required','浏览器没有可用的登录上下文');
  if(!newTab){
   const candidates=context.pages().filter(page=>!page.isClosed()&&!this.claims.has(page)&&/^(https?:|data:text\/html|about:blank)/i.test(page.url()));
   let chosen=candidates.at(-1);
   // A fixed read-only query; no caller-supplied JavaScript is evaluated.
   for(const page of candidates.slice(-20))if(await cancellable(page.evaluate(()=>document.hasFocus()),signal).catch(error=>{signal.throwIfAborted();return false;})){chosen=page;break;}
   if(chosen){this.watch(state,chosen);return chosen;}
  }
  if(!create&&!this.claims.size)throw new BrowserFailure('page-required','没有可用网页，请先 browser_navigate');
  if(state.owned.size>=8)throw new BrowserFailure('page-required','此会话已创建 8 个标签页，请关闭不再使用的标签页');
  const page=await cancellable(context.newPage(),signal,late=>late.close().catch(()=>{}));signal.throwIfAborted();
  if(state.cdp){await state.cdp.detach().catch(()=>{});state.cdp=null;}
  this.watch(state,page,true);return page;
 }
 async driver(state,signal){
  const page=state.page;if(!page||page.isClosed())throw new BrowserFailure('page-required','网页已关闭，请重新 browser_navigate');
  if(!state.cdp){state.cdp=await cancellable(page.context().newCDPSession(page),signal,late=>late.detach().catch(()=>{}));try{await cancellable(state.cdp.send('Accessibility.enable'),signal);}catch(error){signal.throwIfAborted();throw error;}}
  const cdp=state.cdp;
  if(!this.pageTargets.has(page)){try{const {targetInfo}=await cancellable(cdp.send('Target.getTargetInfo'),signal);if(targetInfo?.targetId){this.pageTargets.set(page,targetInfo.targetId);this.targets.set(targetInfo.targetId,{id:state.id,owned:state.owned.has(page)});state.currentTarget=targetInfo.targetId;}}catch{signal.throwIfAborted();}}
  return {page,async send(method,args={}){
   signal.throwIfAborted();const stop=()=>{state.cdp=null;cdp.detach().catch(()=>{});};signal.addEventListener('abort',stop,{once:true});
   try{return await cancellable(cdp.send(method,args),signal);}finally{signal.removeEventListener('abort',stop);}
  }};
 }
 async release(id){
  const state=this.states.get(id);if(!state)return;state.released=true;state.abort.abort();this.invalidate(state);
  await state.tail.catch(()=>{});await state.cdp?.detach().catch(()=>{});state.cdp=null;
  for(const [page,hooks]of state.pageHooks){page.off('framenavigated',hooks.navigation);page.off('close',hooks.closed);if(this.claims.get(page)===id)this.claims.delete(page);}
  for(const page of state.owned)if(!page.isClosed())await page.close().catch(()=>{});
  for(const [target,owner]of this.targets)if(owner.id===id)this.targets.delete(target);
  if(this.states.get(id)===state)this.states.delete(id);
 }
 async reset(){this.generation++;for(const id of [...this.states.keys()])await this.release(id);const browser=this.browser;this.browser=null;await browser?.close().catch(()=>{});}
 async close(){this.closed=true;if(this.idleTimer){this.cancel(this.idleTimer);this.idleTimer=null;}await this.reset();await this.connecting?.catch(()=>{});}
}
