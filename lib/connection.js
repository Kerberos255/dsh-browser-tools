import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';

export class BrowserFailure extends Error{constructor(code,message,details={}){super(message);this.name='BrowserFailure';this.code=code;this.details=details;}}
export function cancellable(promise,signal,late){
 if(signal.aborted){Promise.resolve(promise).then(late??(()=>{}),()=>{});return Promise.reject(signal.reason);}
 return new Promise((resolve,reject)=>{let aborted=false;const stop=()=>{aborted=true;reject(signal.reason);};signal.addEventListener('abort',stop,{once:true});Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',stop);if(aborted)late?.(value);else resolve(value);},error=>{signal.removeEventListener('abort',stop);if(!aborted)reject(error);});});
}
export class Connection {
 constructor(config,{connect=(url,options)=>chromium.connectOverCDP(url,options),artifactsDir}={}){this.config=config;this.connect=connect;this.artifactsDir=artifactsDir;this.browser=null;this.connecting=null;this.selecting=Promise.resolve();this.states=new Map();this.claims=new Map();this.targets=new Map();this.pageTargets=new WeakMap();this.closed=false;this.generation=0;}
 state(id){let state=this.states.get(id);if(!state){state={id,run:randomUUID(),refPrefix:randomUUID().slice(0,8),counter:0,epoch:0,refs:new Map(),secretNodes:new WeakMap(),page:null,cdp:null,tail:Promise.resolve(),abort:new AbortController(),owned:new Set(),pageHooks:new Map(),released:false};this.states.set(id,state);}return state;}
 invalidate(state){state.epoch++;state.refs.clear();}
 async ready(signal){
  signal.throwIfAborted();if(this.closed)throw new BrowserFailure('browser-unavailable','浏览器插件已卸载');
  if(this.browser?.isConnected())return this.browser;
  if(!this.connecting){
   const generation=this.generation,config=this.config();
   this.connecting=(async()=>{const artifactsDir=await this.artifactsDir?.();return this.connect(config.cdpUrl,{timeout:config.actionTimeoutMs,noDefaults:true,...artifactsDir?{artifactsDir}: {}});})().then(async browser=>{
    if(this.closed||generation!==this.generation){await browser.close();throw new BrowserFailure('browser-unavailable','浏览器设置已更新，请重新调用');}
    this.browser=browser;browser.on('disconnected',()=>{if(this.browser===browser){this.browser=null;for(const state of this.states.values()){state.cdp=null;this.invalidate(state);}}});
    // Recover ownership of still-open targets after a transport disconnect.
    if(this.targets.size)for(const page of browser.contexts()[0]?.pages()??[]){let session;try{session=await page.context().newCDPSession(page);const {targetInfo}=await session.send('Target.getTargetInfo');const owner=this.targets.get(targetInfo?.targetId),state=owner&&this.states.get(owner.id);if(state){this.pageTargets.set(page,targetInfo.targetId);if(owner.owned)state.owned.add(page);this.claims.set(page,state.id);if(state.currentTarget===targetInfo.targetId)this.watch(state,page,owner.owned);}}catch{}finally{await session?.detach().catch(()=>{});}}
    return browser;
   }).catch(()=>{
    const endpoint=new URL(config.cdpUrl),port=endpoint.port||(['https:','wss:'].includes(endpoint.protocol)?'443':'80');
    throw new BrowserFailure('browser-unavailable','无法连接浏览器 '+endpoint.origin+'。请用户手动启动 CloakBrowser；命令示例：chrome.exe --remote-debugging-address='+endpoint.hostname.replace(/^\[|\]$/g,'')+' --remote-debugging-port='+port+' --user-data-dir=浏览器配置目录。完整路径与配置目录见插件 README。');
   }).finally(()=>{this.connecting=null;});
  }
  return cancellable(this.connecting,signal);
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
 async close(){this.closed=true;await this.reset();await this.connecting?.catch(()=>{});}
}
