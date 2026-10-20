import { defineConfig } from './plugin-settings/remote-config.js';
import { defaultDomains,rules } from './lib/policy.js';
export const schema=defineConfig({enabled:true,cdpUrl:'http://127.0.0.1:18801',launch:false,launchExecutablePath:'',launchUserDataDir:'',launchArgsJson:'[]',launchTimeoutMs:20000,idleExitMinutes:30,defaultTier:'interact',domainsJson:JSON.stringify(defaultDomains,null,2),confirmations:['submit','publish','purchase','delete','send','transfer'],credentialRulesJson:'[]',maxSnapshotChars:4000,actionTimeoutMs:30000,recordText:false},{
 cdpUrl:value=>{try{const url=new URL(value);return ['http:','https:','ws:','wss:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password;}catch{return false;}},
 launch:value=>typeof value==='boolean',
 launchExecutablePath:value=>typeof value==='string'&&value.length<=1024&&!/[\r\n]/.test(value),
 launchUserDataDir:value=>typeof value==='string'&&value.length<=1024&&!/[\r\n]/.test(value),
 launchArgsJson:value=>{try{const rows=JSON.parse(value);return Array.isArray(rows)&&rows.length<=20&&rows.every(row=>typeof row==='string'&&row.length<=512&&!/[\r\n]/.test(row));}catch{return false;}},
 launchTimeoutMs:value=>Number.isSafeInteger(value)&&value>=2000&&value<=120000,
 idleExitMinutes:value=>Number.isSafeInteger(value)&&value>=0&&value<=1440,
 defaultTier:value=>['read','interact','blocked'].includes(value),domainsJson:value=>{try{rules(value);return true;}catch{return false;}},
 confirmations:value=>value.length<=6&&new Set(value).size===value.length&&value.every(key=>['submit','publish','purchase','delete','send','transfer'].includes(key)),
 credentialRulesJson:value=>{try{const rows=JSON.parse(value);return Array.isArray(rows)&&rows.length<=50&&rows.every(row=>row&&Object.keys(row).every(key=>['ref','match'].includes(key))&&typeof row.ref==='string'&&/^[A-Za-z0-9_.:/-]{1,256}$/.test(row.ref)&&rules(JSON.stringify([{match:row.match,tier:'interact'}])).length===1);}catch{return false;}},
 maxSnapshotChars:value=>Number.isSafeInteger(value)&&value>=1000&&value<=65536,actionTimeoutMs:value=>Number.isSafeInteger(value)&&value>=1000&&value<=120000,
});
