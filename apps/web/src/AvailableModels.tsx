import {useState} from 'react';
import {MODEL_CAPABILITIES,MODEL_KINDS,MODEL_API_PATHS,type ModelCapability,type ModelDefinition} from '@ai-gateway/contracts';
import {Field,money,Panel,Status} from './components';
import {ModelCapabilities,ModelCard,ModelFacts} from './ModelCard';
import {gatewayBaseUrl} from './client';
import {purposeLabels} from './Online';
import type {PageProps} from './WorkspacePages';

export function AvailableModels({data,purposeId,setPurpose,setPage,refresh,detail,onUseModel}:Pick<PageProps,'data'|'purposeId'|'setPurpose'|'setPage'|'refresh'|'detail'|'onUseModel'>){
  const [query,setQuery]=useState(''),[capability,setCapability]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const purpose=data.purposes.find(p=>p.id===purposeId)??data.purposes[0];
  const models=purpose.catalogModels??purpose.models,search=query.trim().toLocaleLowerCase();
  const definition=(id:string)=>data.definitions.find(d=>d.modelId===id);
  const rows=models.filter(m=>{const d=definition(m.modelId);return (!search||[m.name,m.modelId,d?.vendor,d?.description].some(v=>v?.toLocaleLowerCase().includes(search)))&&(!capability||d?.capabilities?.includes(capability as ModelCapability));});
  async function reload(){if(busy)return;setBusy(true);setError('');try{if(!await refresh())setError('模型数据未能刷新，已保留上次结果。请稍后重试。');}catch{setError('模型数据未能刷新，已保留上次结果。请稍后重试。');}finally{setBusy(false);}}
  async function copy(modelId:string){setNotice('');setError('');try{await navigator.clipboard.writeText(modelId);setNotice(`已复制模型标识：${modelId}`);}catch{setError('复制失败，请在模型详情中选择并复制模型标识。');}}
  function show(modelId:string){
    const selectedPurpose=purpose.id;
    detail('可用模型详情',latest=>{
      const current=latest.purposes.find(p=>p.id===selectedPurpose),model=(current?.catalogModels??current?.models??[]).find(m=>m.modelId===modelId),d:ModelDefinition|undefined=latest.definitions.find(d=>d.modelId===modelId);
      if(!model)return <p className="notice warning">模型已不在当前用途的开放范围内，请关闭详情后刷新模型列表。</p>;
      const kind=d?.kind??'chat';
      return <>{kind!=='chat'&&<section className="detail-group"><h3>{MODEL_KINDS[kind]} API 接入</h3><p>在密钥与接入中签发当前用途的密钥，再使用下列入口；模型字段填写下方对外模型标识。</p><code>POST {gatewayBaseUrl}{MODEL_API_PATHS[kind]}</code><p className="secondary">{kind==='asr'?'使用 multipart/form-data，包含 model 和 file 音频文件。':kind==='video'?'提交后返回平台任务 ID；使用同一用途密钥 GET /v1/videos/{id} 查询，完成后 GET /v1/videos/{id}/content 获取视频。':kind==='tts'?'JSON 包含 model、input、voice，返回音频二进制。':kind==='embeddings'?'JSON 包含 model 和 input，返回向量数组。':kind==='rerank'?'JSON 包含 model、query、documents，返回相关性排序。':'JSON 包含 model、prompt、n，返回图片地址或 Base64 数据。'}</p></section>}<dl className="detail-lead"><div><dt>使用状态</dt><dd><Status value={model.status==='ready'?'active':'unavailable'} label={purposeLabels[model.status]}/></dd></div><div><dt>当前用途</dt><dd>{current?.name}</dd></div><div><dt>模型适用余额</dt><dd>{money(model.availableAmount)}</dd></div><div><dt>单次调用金额上限</dt><dd>{money(model.largestBatchAmount)}</dd></div></dl>
        <div className="detail-groups"><section className="detail-group"><h3>模型与适用任务</h3><dl className="detail-list"><div><dt>名称</dt><dd>{model.name}</dd></div><div><dt>模型标识</dt><dd><code>{model.modelId}</code></dd></div><div><dt>厂商</dt><dd>{d?.vendor||'未维护'}</dd></div><div><dt>能力说明</dt><dd>{d?.description||'未维护'}</dd></div></dl></section>
        <section className="detail-group"><h3>接入能力与关键参数</h3><ModelCapabilities definition={d}/><ModelFacts definition={d}/><p className="secondary">能力由运营按当前接入维护；未维护不表示不支持。最大输出仅作选型参考，本次输出仍受上下文与实际调用保护限制。</p></section></div></>;
    });
  }
  return <>
    {error&&<p className="notice danger" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    <Panel title="选择适合任务的模型" actions={<button type="button" className="ghost" disabled={busy} onClick={()=>void reload()}>{busy?'正在刷新…':'刷新模型'}</button>}>
      <p className="secondary">按当前用途展示已开放给你的模型。能力与参数由运营维护，调用以实际接入和额度为准。</p>
      <div className="call-filter-form"><div className="filter-primary">
        <Field spec={{key:'purpose',label:'使用用途',type:'select',options:data.purposes.map(p=>({value:p.id,label:p.name}))}} value={purpose.id} onChange={value=>{setPurpose(String(value));setError('');setNotice('');}}/>
        <Field spec={{key:'query',label:'搜索模型',type:'text'}} value={query} onChange={value=>setQuery(String(value))}/>
        <Field spec={{key:'capability',label:'接入能力',type:'select',options:[{value:'',label:'全部能力'},...Object.entries(MODEL_CAPABILITIES).map(([value,label])=>({value,label}))]}} value={capability} onChange={value=>setCapability(String(value))}/>
      </div><div className="filter-actions"><span role="status">即时筛选 · 显示 {rows.length} / {models.length} 个模型</span>{(query||capability)&&<button type="button" className="ghost" onClick={()=>{setQuery('');setCapability('');}}>清除筛选</button>}</div></div>
    </Panel>
    {rows.length?<div className="model-card-grid" aria-busy={busy}>{rows.map(model=><ModelCard key={`${purpose.id}:${model.modelId}`} model={model} definition={definition(model.modelId)} onCopy={()=>void copy(model.modelId)} onDetail={()=>show(model.modelId)} onUse={()=>onUseModel(purpose.id,model.modelId)} onQuota={()=>setPage('quota',purpose.id)}/>)}</div>:<Panel title={models.length?'没有符合条件的模型':'当前用途暂无开放模型'}><div className="empty-state"><p>{models.length?'请调整名称或能力筛选，或清除条件查看全部模型。':purpose.status==='not_open'?'尚未开通当前用途。可以在“我的额度”申请模型与额度。':'当前授权范围内没有开放模型，请联系企业运营检查开放范围。'}</p><div className="actions">{models.length?<button type="button" className="ghost" onClick={()=>{setQuery('');setCapability('');}}>清除筛选</button>:<button type="button" className="ghost" onClick={()=>setPage('quota',purpose.id)}>查看我的额度</button>}</div></div></Panel>}
    <p className="secondary">同一额度来源可供多个模型共用，卡片数量不代表独立额度。具体来源与有效期请查看“我的额度”。</p>
  </>;
}
