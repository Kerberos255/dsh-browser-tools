import { BrowserFailure,cancellable } from './connection.js';
import { tierFor,confirmationFor,safeUrl } from './policy.js';
import { buildSnapshot,parseRef } from './snapshot.js';

// Fixed DOM metadata query. It contains neither input text nor caller-provided code.
const describe='function(){ const e=this;const r=e.getBoundingClientRect();const hit=e.ownerDocument.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {url:e.ownerDocument.URL,tag:e.tagName,type:e.type||"",text:(e.innerText||e.getAttribute("aria-label")||"").slice(0,512),href:e.href||"",download:e.hasAttribute("download"),formAction:e.form?.action||"",submit:(e.tagName==="BUTTON"&&e.type!=="button"&&!!e.form)||(e.tagName==="INPUT"&&["submit","image"].includes(e.type)),editable:e.isContentEditable||e.tagName==="TEXTAREA"||(e.tagName==="INPUT"&&!["file","button","submit","checkbox","radio","hidden"].includes(e.type)),password:e.type==="password",visible:r.width>0&&r.height>0,hit:!!hit&&(hit===e||e.contains(hit))};}';
// Only fixed read-only code runs in the page. Sensitive values never leave the DOM.
const inputSummary='function(secret){const e=this;const key=[e.type,e.name,e.id,e.autocomplete,e.getAttribute("aria-label")||""].join(" ");if(secret||e.ownerDocument[Symbol.for("dsh.browser.secretInputs")]?.has(e)||e.type==="password"||/(?:password|passwd|secret|token|api.?key|one.time.code|密码|口令|密钥|验证码)/i.test(key))return {sensitive:true};if(!["INPUT","TEXTAREA","SELECT"].includes(e.tagName))return null;const value=String(e.value||"");return {value:value.slice(0,300),truncated:value.length>300};}';
// Persist a value-free marker in this document so transport resets and plugin reloads
// cannot reveal secrets typed into otherwise ordinary fields. Navigation drops it.
const markSecret='function(){const key=Symbol.for("dsh.browser.secretInputs"),doc=this.ownerDocument;if(!doc[key])Object.defineProperty(doc,key,{value:new WeakSet()});doc[key].add(this);}';
async function rememberSecret(driver,backend){
 const resolved=await driver.send('DOM.resolveNode',{backendNodeId:backend}),objectId=resolved.object?.objectId;if(!objectId)throw new BrowserFailure('ref-not-found','输入框已移除，请重新快照');
 try{const result=await driver.send('Runtime.callFunctionOn',{objectId,functionDeclaration:markSecret,returnByValue:true});if(result.exceptionDetails)throw new BrowserFailure('input-denied','无法登记保密输入，未填入内容');}
 finally{await driver.send('Runtime.releaseObject',{objectId}).catch(()=>{});}
}
async function snapshotValues(nodes,state,driver){
 const values=new Map(),secret=state.secretNodes.get(state.page);
 for(const node of nodes.filter(row=>!row.ignored&&row.backendDOMNodeId&&['textbox','searchbox','combobox','spinbutton'].includes(row.role?.value)).slice(0,300)){
  const resolved=await driver.send('DOM.resolveNode',{backendNodeId:node.backendDOMNodeId}),objectId=resolved.object?.objectId;if(!objectId)continue;
  try{const result=await driver.send('Runtime.callFunctionOn',{objectId,functionDeclaration:inputSummary,arguments:[{value:secret?.has(node.backendDOMNodeId)??false}],returnByValue:true});if(!result.exceptionDetails&&result.result?.value)values.set(node.backendDOMNodeId,result.result.value);}
  finally{await driver.send('Runtime.releaseObject',{objectId}).catch(()=>{});}
 }return values;
}
export function allowed(url,config,interact=false){const tier=tierFor(url,config);if(tier==='blocked'||interact&&tier!=='interact')throw new BrowserFailure('tier-denied','当前站点为 '+tier+' 档；请在浏览器插件设置页调整规则后再操作',{tier});return tier;}
async function resolveTarget(state,driver,ref){
 const row=state.refs.get(parseRef(ref));if(!row||row.epoch!==state.epoch||row.page!==state.page)throw new BrowserFailure('ref-not-found','引用已失效，请重新 browser_snapshot');
 const tree=await driver.send('Accessibility.getPartialAXTree',{backendNodeId:row.backend,fetchRelatives:false}),current=tree.nodes?.find(node=>node.backendDOMNodeId===row.backend&&!node.ignored);
 if(!current||current.role?.value!==row.role||String(current.name?.value??'').slice(0,512)!==row.name)throw new BrowserFailure('ref-not-found','页面元素已变化，请重新 browser_snapshot');
 const node=await driver.send('DOM.resolveNode',{backendNodeId:row.backend});if(!node.object?.objectId)throw new BrowserFailure('ref-not-found','元素已移除，请重新 browser_snapshot');
 try{const result=await driver.send('Runtime.callFunctionOn',{objectId:node.object.objectId,functionDeclaration:describe,returnByValue:true});if(result.exceptionDetails||!result.result?.value)throw new BrowserFailure('ref-not-found','无法检查元素，请重新 browser_snapshot');return {...row,...result.result.value};}
 finally{await driver.send('Runtime.releaseObject',{objectId:node.object.objectId}).catch(()=>{});}
}
export class Actions {
 constructor(connection,artifacts,{approve,credential,readOnly}={}){this.connection=connection;this.artifacts=artifacts;this.approve=approve;this.credential=credential;this.readOnly=readOnly;}
 async target(state,driver,args,config,interact){
  allowed(state.page.url(),config,interact);if(interact&&this.readOnly?.(state))throw new BrowserFailure('tier-denied','此会话使用只读权限，浏览器点击和输入已禁用');
  const target=await resolveTarget(state,driver,args.ref);allowed(target.url,config,interact);return target;
 }
 async confirm(state,target,kind,exec,config,driver){
  const reason=confirmationFor(kind,target,config);if(!reason)return;
  if(!this.approve)throw new BrowserFailure('needs-confirmation','此动作需要原生人工审批，当前没有审批服务');
  const outcome=await this.approve({agent:exec.agent,toolName:exec.name,callId:exec.callId,reason:'浏览器将'+reason+'：'+target.name+'（'+safeUrl(target.url)+'）',signal:exec.signal});
  exec.signal.throwIfAborted();if(outcome!=='allowed-once')throw new BrowserFailure('needs-confirmation','原生审批未授权此动作：'+outcome);
  // Re-read the exact bound reference after the human responds; approval is one-use.
  const latest=await resolveTarget(state,driver,'['+parseRef(exec.arguments.ref)+']');
  if(['url','href','formAction','tag','type','text','submit'].some(key=>latest[key]!==target[key]))throw new BrowserFailure('ref-not-found','审批期间页面或动作发生变化，请重新快照并审批');
  allowed(latest.url,config,true);await this.artifacts.log(state,{tool:exec.name,phase:'approved',callId:exec.callId,url:latest.url,approval:'allowed-once'});
 }
 async run(name,args,exec,state,config){
  if(name==='browser_navigate')allowed(args.url,config);
  const page=await this.connection.page(state,exec.signal,{create:name==='browser_navigate',newTab:args.newTab===true});
  const driver=await this.connection.driver(state,exec.signal);const meta=async()=>({url:safeUrl(page.url()),title:(await cancellable(page.title(),exec.signal)).slice(0,512)});
  if(name==='browser_navigate'){
   allowed(args.url,config);this.connection.invalidate(state);state.mutating=true;
   let response;try{response=await cancellable(page.goto(args.url,{waitUntil:args.waitUntil??'domcontentloaded',timeout:args.timeoutMs??config.actionTimeoutMs}),exec.signal);}catch(error){exec.signal.throwIfAborted();throw new BrowserFailure(error.name==='TimeoutError'?'timeout':'navigation-failed','网页导航失败，请检查地址或重新快照');}exec.signal.throwIfAborted();allowed(page.url(),config);const status=response?.status()??null;if(status>=400)throw new BrowserFailure('navigation-failed','网页返回 HTTP '+status,{status});return {...await meta(),status};
  }
  allowed(page.url(),config);
  if(name==='browser_snapshot'){
   const subtree=args.ref?await this.target(state,driver,args,config,false):null;
   const tree=await driver.send('Accessibility.getFullAXTree',{depth:args.depth??12});exec.signal.throwIfAborted();
   const values=await snapshotValues(tree.nodes??[],state,driver);
   const value=buildSnapshot(tree.nodes??[],state,{maxChars:Math.min(args.maxChars??config.maxSnapshotChars,config.maxSnapshotChars),depth:args.depth??12,interactiveOnly:args.interactiveOnly,subtree:subtree?.axId,values},{...await meta(),untrustedContent:true,runDirectory:await this.artifacts.directory(state)});await this.artifacts.snapshot(state,value);return value;
  }
  if(name==='browser_screenshot'){
   if(args.annotate)throw new BrowserFailure('unsupported-action','引用标注尚未实现，请使用普通截图');
   let clip;if(args.ref){const target=await this.target(state,driver,args,config,false),box=await driver.send('DOM.getBoxModel',{backendNodeId:target.backend}),quad=box.model?.border;if(!quad)throw new BrowserFailure('ref-not-found','元素不可见，请重新快照');clip={x:Math.min(quad[0],quad[2],quad[4],quad[6]),y:Math.min(quad[1],quad[3],quad[5],quad[7]),width:box.model.width,height:box.model.height};}
   const filename=await this.artifacts.pngPath(state),buffer=await cancellable(page.screenshot({type:'png',fullPage:args.fullPage??false,...clip?{clip}: {},timeout:config.actionTimeoutMs}),exec.signal);exec.signal.throwIfAborted();
   if(buffer.length>20*1024*1024||buffer.readUInt32BE(0)!==0x89504e47)throw new BrowserFailure('artifact-limit','截图大小或格式无效');
   const fs=await import('node:fs/promises');await fs.writeFile(filename,buffer,{flag:'wx'});return {path:filename,width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20),bytes:buffer.length};
  }
  const target=await this.target(state,driver,args,config,true);
  if(name==='browser_click'){
   if(target.type==='file'||target.download)throw new BrowserFailure('unsupported-action','本版本不提供文件上传或下载动作');
   if(target.href)allowed(target.href,config);if(target.submit&&target.formAction)allowed(target.formAction,config,true);
   await this.confirm(state,target,'click',exec,config,driver);exec.signal.throwIfAborted();
   await driver.send('DOM.scrollIntoViewIfNeeded',{backendNodeId:target.backend});
   const fresh=await resolveTarget(state,driver,args.ref);if(['url','href','formAction','tag','type','text','submit'].some(key=>fresh[key]!==target[key]))throw new BrowserFailure('ref-not-found','动作目标已变化，请重新快照');if(!fresh.visible||!fresh.hit)throw new BrowserFailure('action-failed','元素被遮挡或不可见，请查看截图后重试');
   const {model}=await driver.send('DOM.getBoxModel',{backendNodeId:target.backend}),quad=model?.border;if(!quad)throw new BrowserFailure('action-failed','元素没有可点击区域');
   const x=(quad[0]+quad[2]+quad[4]+quad[6])/4,y=(quad[1]+quad[3]+quad[5]+quad[7])/4,button=args.button??'left';state.mutating=true;this.connection.invalidate(state);
   await driver.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});for(let n=1;n<=(args.double?2:1);n++){await driver.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button,clickCount:n});await driver.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button,clickCount:n});}
   allowed(page.url(),config);return {clicked:{ref:args.ref,role:target.role,name:target.name},...await meta()};
  }
  if(name==='browser_type'){
   if(!target.editable)throw new BrowserFailure('action-failed','该引用不是可编辑输入框');
   if(args.secret&&!['INPUT','TEXTAREA'].includes(target.tag))throw new BrowserFailure('input-denied','保密输入需要原生输入框或文本区');
   if(target.password&&!args.secret)throw new BrowserFailure('input-denied','密码输入请使用 secret 和 credentialRef 或本会话 fromFile');
   let text;if(args.credentialRef){if(!args.secret||!this.credential)throw new BrowserFailure('input-denied','凭据引用须使用 secret，且原生凭据服务可用');const permitted=JSON.parse(config.credentialRulesJson).some(row=>row.ref===args.credentialRef&&tierFor(target.url,{defaultTier:'blocked',domainsJson:JSON.stringify([{match:row.match,tier:'interact'}])})==='interact');if(!permitted)throw new BrowserFailure('input-denied','此凭据未授权给当前站点，请在浏览器插件设置页配置凭据规则');text=await this.credential(args.credentialRef,exec.signal);}
   else if(args.fromFile)text=await this.artifacts.input(state,args.fromFile);else{text=args.text;if(args.secret)throw new BrowserFailure('input-denied','secret 使用 credentialRef 或 fromFile；原生会话会记录普通 text 参数');}
   if(typeof text!=='string'||text.length>1024*1024)throw new BrowserFailure('input-denied','输入文本无效或超过 1 MiB');
   if(args.submit&&target.formAction)allowed(target.formAction,config,true);
   await this.confirm(state,target,args.submit?'submit':'type',exec,config,driver);exec.signal.throwIfAborted();
   if(args.secret){let secrets=state.secretNodes.get(page);if(!secrets){secrets=new Set();state.secretNodes.set(page,secrets);}secrets.add(target.backend);await rememberSecret(driver,target.backend);}
   await driver.send('DOM.focus',{backendNodeId:target.backend});state.mutating=true;this.connection.invalidate(state);
   if(args.clear!==false){await cancellable(page.keyboard.press('ControlOrMeta+A'),exec.signal);exec.signal.throwIfAborted();await cancellable(page.keyboard.press('Backspace'),exec.signal);}
   exec.signal.throwIfAborted();await cancellable(page.keyboard.insertText(text),exec.signal);exec.signal.throwIfAborted();
   if(args.submit)await cancellable(page.keyboard.press('Enter'),exec.signal);
   if(config.recordText&&!args.secret)await this.artifacts.log(state,{tool:name,phase:'text',text});
   text=undefined;allowed(page.url(),config);return {typed:{ref:args.ref},submitted:!!args.submit,...await meta()};
  }
  throw new BrowserFailure('unsupported-action','未知浏览器动作');
 }
}
