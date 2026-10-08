export const readDomains=['*.icbc.com.cn','*.ccb.com','*.boc.cn','*.abchina.com','*.bankcomm.com','*.cmbchina.com','*.alipay.com','pay.weixin.qq.com','*.unionpay.com','*.95516.com','*.gov.cn','*.chinatax.gov.cn','*.zhipin.com','*.zhaopin.com','*.51job.com','*.liepin.com','*.lagou.com'];
export const defaultDomains=readDomains.map(match=>({match,tier:'read'}));
const ranks={interact:0,read:1,blocked:2};
const escape=text=>text.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*');
export function rules(text){
 const rows=JSON.parse(text);if(!Array.isArray(rows)||rows.length>200)throw new Error('站点规则须为不超过 200 项的 JSON 数组');
 for(const row of rows){if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!['match','tier'].includes(key))||typeof row.match!=='string'||row.match.length>512||!Object.hasOwn(ranks,row.tier)||!/^([a-z0-9*.-]+)(\/[^\s?#]*)?$/i.test(row.match)||row.match.split('/')[0].includes('..'))throw new Error('站点规则格式无效');}
 return rows;
}
export function tierFor(value,config){
 let url;try{url=new URL(value);}catch{return 'blocked';}
 if(!['http:','https:','about:'].includes(url.protocol)||url.username||url.password)return 'blocked';
 // Only a blank document is allowed outside HTTP; data/script/file schemes are closed.
 if(url.protocol==='about:')return value==='about:blank'?config.defaultTier:'blocked';
 let best=null;
 const hostname=url.hostname.toLowerCase().replace(/\.+$/,'');
 for(const row of rules(config.domainsJson)){
  const slash=row.match.indexOf('/'),host=(slash<0?row.match:row.match.slice(0,slash)).toLowerCase(),pathname=slash<0?'':row.match.slice(slash);
  const hostMatch=new RegExp('^'+escape(host)+'$','i').test(hostname)||(host.startsWith('*.')&&hostname===host.slice(2));
  if(!hostMatch||pathname&&!new RegExp('^'+escape(pathname)+'$').test(url.pathname))continue;
  const score=row.match.replaceAll('*','').length;if(!best||score>best.score||score===best.score&&ranks[row.tier]>ranks[best.tier])best={score,tier:row.tier};
 }
 return best?.tier??config.defaultTier;
}
export function safeUrl(value){try{const url=new URL(value);return ['about:','data:'].includes(url.protocol)?url.protocol+(url.protocol==='about:'?'blank':'[local-html]'):url.origin+url.pathname;}catch{return '[invalid-url]';}}
export function confirmationFor(kind,target,config){
 const enabled=new Set(config.confirmations),text=[target.name,target.text,target.type,target.formAction,target.href].filter(Boolean).join(' ').slice(0,2048);
 if(kind==='submit'&&enabled.has('submit'))return '提交表单';
 const patterns={submit:/\bsubmit\b|提交|确认提交|投递|申请岗位/i,publish:/\b(publish|post)\b|发布|发表/i,purchase:/\b(buy|purchase|pay|checkout|order now)\b|购买|支付|结算|下单/i,delete:/\b(delete|remove)\b|删除|移除/i,send:/\b(send|share)\b|发送|分享/i,transfer:/\b(transfer|remit)\b|转账|汇款/i};
 for(const [key,pattern]of Object.entries(patterns))if(enabled.has(key)&&pattern.test(text))return {submit:'提交表单',publish:'发布内容',purchase:'购买或支付',delete:'删除内容',send:'对外发送',transfer:'转账'}[key];
 if(target.submit&&enabled.has('submit'))return '提交表单';return null;
}
