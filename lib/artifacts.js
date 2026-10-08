import fs from 'node:fs/promises';
import path from 'node:path';
import { safeUrl } from './policy.js';
import { BrowserFailure } from './connection.js';
import { randomUUID } from 'node:crypto';
export class Artifacts {
 constructor(root){this.root=path.resolve(root);}
 async directory(state){
  const directory=path.join(this.root,state.run);
  await fs.mkdir(directory,{recursive:true});const resolved=await fs.realpath(directory),base=await fs.realpath(this.root);
  if(!resolved.startsWith(base+path.sep)||resolved!==directory)throw new BrowserFailure('artifact-denied','浏览器产物目录不允许目录联接');return resolved;
 }
 async log(state,row){
  const directory=await this.directory(state),filename=path.join(directory,'actions.jsonl');
  await this.checkFile(filename);
  if((await fs.stat(filename).catch(()=>({size:0}))).size>4*1024*1024)throw new BrowserFailure('artifact-limit','此会话浏览器审计记录已达到上限');
  const value={ts:new Date().toISOString(),...row};if(value.url)value.url=safeUrl(value.url);await fs.appendFile(filename,JSON.stringify(value)+'\n',{encoding:'utf8'});
 }
 async checkFile(filename){const stat=await fs.lstat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(stat&&(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1))throw new BrowserFailure('artifact-denied','产物文件不允许符号链接或硬链接');}
 async snapshot(state,value){const directory=await this.directory(state);if(state.counter>1000000)throw new BrowserFailure('artifact-limit','此会话快照引用已达到上限');const filename=path.join(directory,'snapshot.json');await this.checkFile(filename);await fs.writeFile(filename,JSON.stringify(value,null,2)+'\n','utf8');}
 async pngPath(state){const directory=await this.directory(state);return path.join(directory,'screenshot-'+Date.now()+'-'+randomUUID().slice(0,8)+'.png');}
 async input(state,relative){
  const directory=await this.directory(state);if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||path.basename(relative)!==relative||/[:\x00-\x1f]/.test(relative)||/[. ]$/.test(relative))throw new BrowserFailure('input-denied','fromFile 只接受本会话产物目录内的文件名');
  const filename=path.resolve(directory,relative),resolved=await fs.realpath(filename);
  if(!resolved.startsWith(directory+path.sep)||resolved!==filename)throw new BrowserFailure('input-denied','输入文件不能越出本会话产物目录');await this.checkFile(resolved);const stat=await fs.stat(resolved);if(!stat.isFile()||stat.size>1024*1024)throw new BrowserFailure('input-denied','输入文件须为不超过 1 MiB 的文本文件');return fs.readFile(resolved,'utf8');
 }
}
