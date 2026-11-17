import {useId,useState} from 'react';
import {BUILTIN_PROVIDERS,modelProviders,type ModelProvider,type PlatformSnapshot} from '@ai-gateway/contracts';
import {Modal} from './components';
import {markTint,providerHost,providerMark} from './provider-mark';

/* First step of "接入模型服务": pick the provider template, then continue into
   that provider's service form. Card picking is a selection mode; provider and
   credential management stay in their own tables. */
const COMPATIBLE_ID='openai-compatible';
const BUILTIN_IDS=new Set(BUILTIN_PROVIDERS.map(provider=>provider.id));

function providerCard(provider:ModelProvider,services:number,onPick:(providerId:string)=>void,wide=false,note?:string){
  const mark=providerMark(provider.id,provider.name),host=providerHost(provider.baseUrl);
  return <button type="button" key={provider.id} className={`provider-card${wide?' is-wide':''}`} disabled={!provider.active} onClick={()=>onPick(provider.id)}>
    <span className="provider-card-mark" style={{background:markTint(mark.color),color:mark.color}} aria-hidden="true">{mark.label}</span>
    <span className="provider-card-text">
      <strong>{provider.name}</strong>
      <small>{note??[host,services?`${services} 个服务`:'尚未接入服务'].filter(Boolean).join(' · ')}</small>
    </span>
    {!provider.active&&<span className="tag provider-card-flag">已停用</span>}
  </button>;
}

export function ProviderPicker({data,onPick,onClose}:{data:PlatformSnapshot;onPick:(providerId:string)=>void;onClose:()=>void}){
  const [query,setQuery]=useState(''),[scope,setScope]=useState<'all'|'builtin'|'custom'>('all'),searchId=useId();
  const providers=modelProviders(data.providers),count=(id:string)=>data.services.filter(service=>(service.providerId??COMPATIBLE_ID)===id).length;
  const compatible=providers.find(provider=>provider.id===COMPATIBLE_ID),builtin=providers.filter(provider=>provider.id!==COMPATIBLE_ID&&BUILTIN_IDS.has(provider.id)),custom=providers.filter(provider=>!BUILTIN_IDS.has(provider.id));
  const keyword=query.trim().toLowerCase(),match=(provider:ModelProvider)=>!keyword||[provider.name,provider.description,provider.baseUrl,provider.id].some(value=>value.toLowerCase().includes(keyword));
  const visibleBuiltin=(scope==='custom'?[]:builtin).filter(match),visibleCustom=(scope==='builtin'?[]:custom).filter(match),showCompatible=scope!=='custom'&&!!compatible&&match(compatible);
  const empty=!showCompatible&&!visibleBuiltin.length&&!visibleCustom.length;
  return <Modal title="选择供应商" onClose={onClose}>
    <p className="secondary">先选择供应商，再填写该厂商的模型服务地址与密钥。</p>
    <input id={searchId} className="provider-picker-search" type="search" value={query} aria-label="搜索供应商名称或网址" placeholder="搜索名称或网址，例如 deepseek、siliconflow" onChange={event=>setQuery(event.target.value)}/>
    {custom.length>0&&<div className="provider-picker-scope" role="group" aria-label="供应商来源">
      {([['all','全部',providers.length],['builtin','内置模板',builtin.length],['custom','自定义供应商',custom.length]] as const).map(([value,label,total])=>
        <button key={value} type="button" className={`provider-picker-scope-option${scope===value?' is-active':''}`} aria-pressed={scope===value} onClick={()=>setScope(value)}>{label}<span>{total}</span></button>)}
    </div>}
    {showCompatible&&providerCard({...compatible,name:'自定义配置',description:'手动填写请求地址与密钥'},count(compatible.id),onPick,true,'手动填写请求地址与密钥')}
    {!!visibleBuiltin.length&&<><h3 className="provider-picker-section">内置模板</h3><div className="provider-picker-grid">{visibleBuiltin.map(provider=>providerCard(provider,count(provider.id),onPick))}</div></>}
    {!!visibleCustom.length&&<><h3 className="provider-picker-section">自定义供应商</h3><div className="provider-picker-grid">{visibleCustom.map(provider=>providerCard(provider,count(provider.id),onPick))}</div></>}
    {empty&&<div className="empty">没有匹配的供应商。清除搜索词，或先到「供应商」页面创建供应商。</div>}
  </Modal>;
}
