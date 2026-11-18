import {useRef,useState} from 'react';
import {MODEL_API_PATHS,MODEL_CAPABILITIES,MODEL_KINDS,type ModelCapability,type ModelDefinition,type ModelKind} from '@ai-gateway/contracts';
import {Field,money,Panel,Status} from './components';
import {ModelCapabilities,ModelFacts} from './model-facts';
import {ModelIdentity} from './model-surface';
import {gatewayBaseUrl} from './client';
import {purposeLabels} from './Online';
import type {PageProps} from './WorkspacePages';
import type {PurposeView} from '@ai-gateway/contracts';

type ModelRow=PurposeView['models'][number];
const groupOf=(status:string):'ready'|'action'|'unavailable'=>status==='ready'?'ready':['no_quota','quota_insufficient','price_unconfigured'].includes(status)?'action':'unavailable';
const groups:[string,string][]=[['ready','可直接使用'],['action','需要处理额度或价格'],['unavailable','暂不可用']];

export function AvailableModels({data,purposeId,setPurpose,setPage,refresh,onUseModel}:Pick<PageProps,'data'|'purposeId'|'setPurpose'|'setPage'|'refresh'|'onUseModel'>){
  const [query,setQuery]=useState(''),[capability,setCapability]=useState(''),[kind,setKind]=useState(''),[only,setOnly]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[selected,setSelected]=useState('');
  const rowsRef=useRef(new Map<string,HTMLButtonElement>());
  const purpose=data.purposes.find(p=>p.id===purposeId)??data.purposes[0];
  const models=purpose.catalogModels??purpose.models,search=query.trim().toLocaleLowerCase();
  const definition=(id:string)=>data.definitions.find(item=>item.modelId===id);
  const kindOf=(id:string):ModelKind=>definition(id)?.kind??'chat';
  const filtered=models.filter(model=>{
    const item=definition(model.modelId);
    if(search&&![model.name,model.modelId,item?.vendor,item?.description].some(value=>value?.toLocaleLowerCase().includes(search)))return false;
    if(capability&&!item?.capabilities?.includes(capability as ModelCapability))return false;
    if(kind&&kindOf(model.modelId)!==kind)return false;
    if(only==='ready'&&model.status!=='ready')return false;
    return true;
  });
  const counts=[['ready','可直接使用'],['action','需要处理额度或价格'],['unavailable','暂不可用']].map(([key,label])=>[key,label,filtered.filter(model=>groupOf(model.status)===key).length] as const);
  const activeRow=filtered.find(model=>model.modelId===selected)??filtered.find(model=>model.status==='ready')??filtered[0];
  const activeId=activeRow?.modelId??'',filters=[query.trim()?'搜索':'',capability?'接入能力':'',kind?'模型类型':'',only?'仅可直接使用':''].filter(Boolean).length;
  const clear=()=>{setQuery('');setCapability('');setKind('');setOnly('');};
  async function reload(){if(busy)return;setBusy(true);setError('');try{if(!await refresh())setError('模型数据未能刷新，已保留上次结果。请稍后重试。');}catch{setError('模型数据未能刷新，已保留上次结果。请稍后重试。');}finally{setBusy(false);}}
  async function copy(modelId:string){setNotice('');setError('');try{await navigator.clipboard.writeText(modelId);setNotice(`已复制模型标识：${modelId}`);}catch{setError('复制失败，请在模型详情中选择并复制模型标识。');}}
  function move(event:React.KeyboardEvent<HTMLDivElement>){
    if(!filtered.length||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();
    const index=filtered.findIndex(model=>model.modelId===activeId);
    const next=filtered[event.key==='Home'?0:event.key==='End'?filtered.length-1:Math.min(filtered.length-1,Math.max(0,index+(event.key==='ArrowDown'?1:-1)))];
    if(next){setSelected(next.modelId);rowsRef.current.get(next.modelId)?.focus();}
  }
  if(!purpose)return <Panel title="可用模型"><p className="empty-state">当前没有可用用途。请先申请模型与额度。</p></Panel>;
  const singleCallLimit=Math.max(0,...models.map(model=>model.largestBatchAmount));
  return <>
    {error&&<p className="notice danger" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    <Panel title="按用途选择模型" actions={<button type="button" className="ghost" disabled={busy} onClick={()=>void reload()}>{busy?'正在刷新…':'刷新模型'}</button>}>
      <div className="available-purpose">
        <Field spec={{key:'available-purpose',label:'使用用途',type:'select',options:data.purposes.map(item=>({value:item.id,label:item.name}))}} value={purpose.id} onChange={value=>{setPurpose(String(value));setSelected('');setError('');setNotice('');}}/>
        <div className="available-facts">
          <span><small>用途余额</small><b>{money(purpose.availableAmount)}</b></span>
          <span><small>单次调用上限</small><b>{money(singleCallLimit)}</b></span>
          <span><small>开放模型</small><b>{models.length}</b></span>
        </div>
        <button type="button" className="ghost" onClick={()=>setPage('quota',purpose.id)}>我的额度</button>
      </div>
      <p className="secondary">按当前用途展示已开放给你的模型。能力与参数由运营维护，调用以实际接入和额度为准。</p>
      <form className="call-filter-form" onSubmit={event=>event.preventDefault()}>
        <div className="filter-primary">
          <label>搜索模型<input value={query} placeholder="名称、标识、厂商或说明" onChange={event=>setQuery(event.target.value)}/></label>
          <label>模型类型<select value={kind} onChange={event=>setKind(event.target.value)}><option value="">全部类型</option>{Object.entries(MODEL_KINDS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          <label>接入能力<select value={capability} onChange={event=>setCapability(event.target.value)}><option value="">全部能力</option>{Object.entries(MODEL_CAPABILITIES).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          <label>使用范围<select value={only} onChange={event=>setOnly(event.target.value)}><option value="">全部模型</option><option value="ready">仅可直接使用</option></select></label>
        </div>
        <div className="filter-actions">
          <span className="filter-state" role="status">即时筛选 · 显示 {filtered.length} / {models.length} 个模型{filters?` · 已设置 ${filters} 项条件`:''}</span>
          <button type="button" className="ghost" disabled={!filters} onClick={clear}>清除筛选</button>
        </div>
      </form>
    </Panel>
    {filtered.length?<div className="split-pane">
      <div className="split-pane-list" role="listbox" aria-label="当前用途的可用模型" onKeyDown={move}>
        {groups.map(([key,label])=>{const items=filtered.filter(model=>groupOf(model.status)===key);if(!items.length)return null;const count=counts.find(item=>item[0]===key)?.[2]??items.length;return <div className="split-group" key={key}>
          <h3>{label}<span>{count}</span></h3>
          <div className="split-list">{items.map(model=>{
            const item=definition(model.modelId),ready=model.status==='ready',caps=(item?.capabilities??[]).slice(0,3).map(value=>MODEL_CAPABILITIES[value]);
            return <button type="button" key={model.modelId} role="option" aria-selected={model.modelId===activeId} tabIndex={model.modelId===activeId?0:-1} ref={element=>{if(element)rowsRef.current.set(model.modelId,element);else rowsRef.current.delete(model.modelId);}} className="split-row" onClick={()=>setSelected(model.modelId)}>
              <div className="split-row-main">
                <ModelIdentity name={model.name} modelId={model.modelId} kind={kindOf(model.modelId)} vendor={item?.vendor}/>
                {caps.length>0&&<small>{caps.join(' · ')}{(item?.capabilities?.length??0)>3?` +${item!.capabilities!.length-3}`:''}</small>}
              </div>
              <span className="split-row-signal">{ready?<span className="quiet-state">可使用</span>:<Status value={groupOf(model.status)==='action'?'pending':'disabled'} label={purposeLabels[model.status]}/>}</span>
            </button>;
          })}</div>
        </div>;})}
      </div>
      {activeRow&&<div className="split-pane-detail"><ModelDetail purpose={purpose} model={activeRow} definition={definition(activeRow.modelId)} kind={kindOf(activeRow.modelId)} onCopy={()=>void copy(activeRow.modelId)} onUse={()=>onUseModel(purpose.id,activeRow.modelId)} onQuota={()=>setPage('quota',purpose.id)}/></div>}
    </div>:<Panel title={models.length?'没有符合条件的模型':'当前用途暂无开放模型'}><div className="empty-state">
      <p>{models.length?'请调整名称、类型或能力筛选，或清除条件查看全部模型。':purpose.status==='not_open'?'尚未开通当前用途。可以在“我的额度”申请模型与额度。':'当前授权范围内没有开放模型，请联系企业运营检查开放范围。'}</p>
      <div className="actions">{models.length?<button type="button" className="ghost" onClick={clear}>清除筛选</button>:<button type="button" className="ghost" onClick={()=>setPage('quota',purpose.id)}>查看我的额度</button>}</div>
    </div></Panel>}
    <p className="secondary">同一额度来源可供多个模型共用，模型数量不代表独立额度。具体来源与有效期请查看“我的额度”。</p>
  </>;
}

function ModelDetail({purpose,model,definition,kind,onCopy,onUse,onQuota}:{purpose:PurposeView;model:ModelRow;definition?:ModelDefinition;kind:ModelKind;onCopy:()=>void;onUse:()=>void;onQuota:()=>void}){
  const ready=model.status==='ready',quota=['no_quota','quota_insufficient'].includes(model.status);
  return <Panel title="模型详情" actions={<Status value={ready?'active':'disabled'} label={purposeLabels[model.status]}/>}>
    <ModelIdentity name={model.name} modelId={model.modelId} kind={kind} vendor={definition?.vendor??'厂商未维护'} onCopy={onCopy}/>
    <dl className="detail-lead">
      <div><dt>用途余额</dt><dd>{money(model.availableAmount)}</dd></div>
      <div><dt>单次调用上限</dt><dd>{money(model.largestBatchAmount)}</dd></div>
      <div><dt>模型类型</dt><dd>{MODEL_KINDS[kind]}</dd></div>
      <div><dt>当前用途</dt><dd>{purpose.name}</dd></div>
    </dl>
    <p>{definition?.description||'能力说明尚未维护，可联系企业运营了解适用任务。'}</p>
    <ModelCapabilities definition={definition}/>
    <ModelFacts definition={definition}/>
    {kind!=='chat'&&<details className="disclosure"><summary>接入方式与参数</summary>
      <p>在密钥与接入中签发当前用途的密钥，再使用下列入口；模型字段填写 <code>{model.modelId}</code>。</p>
      <code>POST {gatewayBaseUrl}{MODEL_API_PATHS[kind]}</code>
      <p className="secondary">{kind==='asr'?'使用 multipart/form-data，包含 model 和 file 音频文件。':kind==='video'?'提交后返回平台任务 ID；使用同一用途密钥 GET /v1/videos/{id} 查询，完成后 GET /v1/videos/{id}/content 获取视频。':kind==='tts'?'JSON 包含 model、input、voice，返回音频二进制。':kind==='embeddings'?'JSON 包含 model 和 input，返回向量数组。':kind==='rerank'?'JSON 包含 model、query、documents，返回相关性排序。':'JSON 包含 model、prompt、n，返回图片地址或 Base64 数据。'}</p>
    </details>}
    {!ready&&<p className="secondary">{quota?'使用范围已保留，请查看当前用途的额度来源。':model.status==='price_unconfigured'?'价格尚未确认，请联系企业运营处理。':'当前接入暂未就绪，请联系企业运营核对来源与验证状态。'}</p>}
    <div className="actions">
      {ready?<button type="button" className="primary" onClick={onUse}>{kind==='chat'?'在线使用':'前往多模态工作台'}</button>:quota?<button type="button" className="primary" onClick={onQuota}>查看我的额度</button>:<button type="button" className="ghost" disabled title={purposeLabels[model.status]}>暂不可用</button>}
      <button type="button" className="ghost" onClick={onCopy}>复制模型标识</button>
    </div>
    <p className="secondary">能力由运营按当前接入维护；未维护不表示不支持。最大输出仅作选型参考，本次输出仍受上下文与实际调用保护限制。</p>
  </Panel>;
}
