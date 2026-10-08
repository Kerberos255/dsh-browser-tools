const interactive=new Set(['button','link','textbox','searchbox','combobox','checkbox','radio','menuitem','menuitemcheckbox','menuitemradio','spinbutton','switch','slider','tab','treeitem']);
const inputRoles=new Set(['textbox','searchbox','combobox','spinbutton']);
import { renderUntrusted } from './untrusted.js';
export function parseRef(value){const match=/^(?:\[([a-f0-9]{8}:\d+)\]|([a-f0-9]{8}:\d+))$/i.exec(String(value??'')),ref=match?.[1]??match?.[2],ordinal=Number(ref?.split(':')[1]);if(!ref||!Number.isSafeInteger(ordinal)||ordinal<1)throw new Error('引用无效，请重新 browser_snapshot');return ref.split(':')[0].toLowerCase()+':'+ordinal;}
export function buildSnapshot(ax,state,{maxChars,depth,interactiveOnly=false,subtree,values=new Map()},meta){
 const parents=new Map(ax.map(row=>[row.nodeId,row.parentId])),within=row=>{let id=row.nodeId;for(let n=0;n<64&&id;n++,id=parents.get(id))if(id===subtree)return true;return !subtree;};
 // Chromium also exposes an input's value through StaticText/InlineTextBox children.
 // Read native field values only through the bounded, privacy-aware DOM summary.
 const inputRoots=new Set(ax.filter(row=>inputRoles.has(row.role?.value)||values.get(row.backendDOMNodeId)?.sensitive).map(row=>row.nodeId));
 const inputChild=row=>{let id=row.parentId;for(let n=0;n<64&&id;n++,id=parents.get(id))if(inputRoots.has(id))return true;return false;};
 meta={...meta,url:String(meta.url??'').slice(0,256),title:String(meta.title??'').slice(0,128)};
 const rows=[],refs=new Map();let truncated=false;
 for(const node of ax){
  if(node.ignored||!node.backendDOMNodeId||!within(node)||inputChild(node))continue;
  let level=0,id=node.parentId;for(;id&&level<64;level++,id=parents.get(id));if(level>depth)continue;
  const role=node.role?.value??'generic',name=String(node.name?.value??'').slice(0,512);
  if(interactiveOnly&&!interactive.has(role)||!name&&!interactive.has(role)||role==='RootWebArea')continue;
  const ref=state.refPrefix+':'+(++state.counter),row={ref:'['+ref+']',role:role==='StaticText'?'text':role,name};
  const input=values.get(node.backendDOMNodeId);
  if(input?.sensitive)row.valueHidden=true;
  else if(input&&typeof input.value==='string'){row.value=input.value;row.valueTruncated=!!input.truncated;}
  for(const key of ['disabled','checked','expanded','selected']){const property=node.properties?.find(prop=>prop.name===key)?.value?.value;if(typeof property==='boolean')row[key]=property;}
  if(renderUntrusted({...meta,truncated:true,nodes:[...rows,row]})[0].text.length>maxChars){truncated=true;continue;}
  rows.push(row);refs.set(ref,{backend:node.backendDOMNodeId,axId:node.nodeId,role,name,epoch:state.epoch,page:state.page});
 }
 state.refs=refs;return {...meta,truncated,nodes:rows};
}
