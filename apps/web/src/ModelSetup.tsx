import {useState} from 'react';
import {api} from './client';
import {Panel,Status,Table,Tabs} from './components';
import {entryReadiness} from './model-readiness';
import type {PageProps} from './WorkspacePages';

export function ModelSetup({data:d,edit,setPage,refresh}:Pick<PageProps,'data'|'edit'|'setPage'|'refresh'>){
  const [checking,setChecking]=useState<string|null>(null),[error,setError]=useState<{id:string;message:string;validation:boolean}|null>(null);
  const definitions=d.definitions.filter(m=>m.active);
  const services=d.services.filter(s=>s.active&&s.mappings.some(m=>definitions.some(def=>def.id===m.definitionId)));
  const priced=services.filter(s=>s.verification==='passed'&&s.mappings.some(m=>definitions.some(def=>def.id===m.definitionId)&&[m.inputPrice,m.outputPrice,m.cachedInputPrice].every(p=>p!==null)));
  const opened=new Set(d.pools.flatMap(p=>p.entries.filter(e=>!entryReadiness(d,e)).map(e=>e.definitionId)));
  const incomplete=services.find(s=>s.verification==='passed'),unverified=services.find(s=>s.verification!=='passed');
  const step=!definitions.length?0:!priced.length?1:!opened.size?2:3;
  const service=unverified??incomplete;
  const existingPool=d.pools.find(p=>p.entries.some(e=>priced.some(s=>s.id===e.serviceId)))??d.pools[0];
  const failure=error&&(!error.validation||d.services.find(s=>s.id===error.id)?.verification!=='passed')?error:null;
  const connectionStatus=(value:string)=>value==='failed'?<span className="tag danger">连接未通过</span>:<Status value={value}/>;
  async function verify(id:string){
    setChecking(id);setError(null);
    try{
      const result=await api<{verification:string;verificationMessage:string}>(`/api/v1/platform/services/${encodeURIComponent(id)}/verify`,{});
      if(!await refresh())throw new Error('连接验证已结束，但页面数据未更新，请刷新后查看结果。');
      if(result.verification!=='passed')setError({id,message:result.verificationMessage||'连接未通过，请检查地址、凭据引用和上游模型标识。',validation:true});
    }catch(e){setError({id,message:e instanceof Error?e.message:'验证失败，请重试。',validation:false});}finally{setChecking(null);}
  }
  const titles=[d.definitions.length?'先启用一个要提供的模型':'先登记一个要提供的模型','下一步：接通模型并确认价格','连接已就绪，下一步开放使用范围',`已有 ${opened.size} 个模型接通并开放`];
  const descriptions=[d.definitions.length?'当前登记的模型均已停用。可以启用已有模型，或按需要登记新模型，再继续连接服务。':'填写同事看到的名称和调用时使用的模型标识。保存后继续连接提供该模型的服务。',incomplete?'已验证的服务仍有价格未确认。输入、输出和缓存输入价格都确认后，才能用于调用；免费明确填 0。':unverified?'服务已保存，验证连接后才能继续开放。验证可能向该服务发送一条短请求。':'填写服务地址、它提供的模型及价格。保存后验证连接，再继续开放。','把已接通的模型加入模型池并开放。模型池是一组可供开通方案、项目或应用选择的模型。','可以继续创建或选择人员开通方案。还可以按需要新增模型，已有配置在下方管理。'];
  const primary=()=>step===0?edit.definition(d.definitions[0]):step===1?incomplete?edit.service(incomplete):unverified?void verify(unverified.id):edit.service(undefined,definitions[0]?.id):step===2?edit.pool(existingPool):setPage('onboarding');
  const label=step===0?d.definitions.length?'启用已有模型':'登记第一个模型':step===1?incomplete?'确认模型价格':unverified?'验证模型连接':'连接模型服务':step===2?existingPool?'调整并开放模型':'创建模型池并开放':'下一步：为人员开通';
  const modelName=(id:string)=>d.definitions.find(m=>m.id===id)?.name??id;
  const limitDescription=(value:typeof d.settings.limits)=>value.mode==='none'?'本级不额外限制':value.mode==='inherit'?'继承企业默认保护':[['RPM',value.rpm],['TPM',value.tpm],['并发',value.concurrency],['单次输出',value.maxOutputTokens]].filter(([,v])=>v!==undefined).map(([label,v])=>`${label} ${v}`).join(' · ')||'本级未设置数值';
  return <>
    <section className="panel task-hero"><span className="eyebrow">模型准备</span><h2>{titles[step]}</h2><p>{descriptions[step]}</p>
      <ol className="journey-steps" aria-label="模型准备进度">{['登记模型','连接与价格','开放使用范围'].map((s,i)=><li key={s} aria-current={step===i?'step':undefined}>{step>i?'✓':i+1} {s}</li>)}</ol>
      <div className="actions"><button className="primary" disabled={!!checking} onClick={primary}>{checking?'正在验证…':label}</button>{step===0&&!!d.definitions.length&&<button className="ghost" onClick={()=>edit.definition()}>登记新模型</button>}{step===1&&!incomplete&&unverified&&<button className="ghost" disabled={!!checking} onClick={()=>edit.service(unverified)}>修改服务配置</button>}{step===3&&<button className="ghost" onClick={()=>edit.service()}>接入另一个模型服务</button>}</div>
      {step===1&&service&&<p className="secondary">当前服务：{(incomplete??service).name} · {connectionStatus((incomplete??service).verification)}</p>}
    </section>
    {failure&&<div className="notice danger" role="alert"><strong>模型连接尚未确认可用</strong><p>配置已保留。修改后可以重新验证。</p><button className="ghost" onClick={()=>{setError(null);edit.service(d.services.find(s=>s.id===failure.id));}}>修改本次服务配置</button><details><summary>查看验证详情</summary><p>{failure.message}</p></details></div>}
    <details className="disclosure"><summary>管理已有配置 · {d.definitions.length} 个模型 / {d.services.length} 个服务 / {d.pools.length} 个池</summary>
      <Tabs labels={['模型服务','模型目录','开放范围','容量与保护']}>
        <Panel title="模型服务" actions={<button className="primary" onClick={()=>edit.service()}>接入模型服务</button>}><Table headers={['服务','连接状态','价格确认','操作']} rows={d.services.map(s=>[<>{s.name}<small className="cell-help">{s.baseUrl}</small></>,<>{connectionStatus(s.active?s.verification:'disabled')}<small className="cell-help">{s.verificationMessage}</small></>,`${s.mappings.filter(m=>[m.inputPrice,m.outputPrice,m.cachedInputPrice].every(p=>p!==null)).length} / ${s.mappings.length} 个模型`,<div className="inline-actions"><button disabled={!!checking} onClick={()=>edit.service(s)}>编辑服务与价格</button><button disabled={!!checking||!s.active} onClick={()=>void verify(s.id)}>{checking===s.id?'正在验证…':'验证连接'}</button></div>])} empty="还没有模型服务，请先完成上方当前步骤。"/></Panel>
        <Panel title="模型目录" actions={<button className="primary" onClick={()=>edit.definition()}>登记模型</button>}><Table headers={['模型','对外标识','单次上下文','状态','操作']} rows={d.definitions.map(m=>[m.name,<code>{m.modelId}</code>,m.contextTokens,m.active?'启用':'停用',<button className="link-button" onClick={()=>edit.definition(m)}>编辑</button>])}/></Panel>
        <Panel title="模型池与开放范围" actions={<><button className="ghost" onClick={()=>edit.defaults()}>设置默认池</button><button className="primary" onClick={()=>edit.pool()}>创建模型池</button></>}><Table headers={['模型池','模型与当前可用性','操作']} rows={d.pools.map(p=>[p.name,<div className="cell-list">{p.entries.length?p.entries.map(e=><span key={e.definitionId}>{modelName(e.definitionId)} · {entryReadiness(d,e)??'已接通并开放'}</span>):'尚未加入模型'}</div>,<button className="link-button" onClick={()=>edit.pool(p)}>调整并预览</button>])}/></Panel>
        <Panel title="限流概览"><p className="secondary">多个池使用同一服务时，共同受服务与共享容量保护；池上限不会增加算力。</p><Table headers={['对象范围','对象','配置来源与上限','共享关系']} rows={[
          ['企业默认','所有继承对象',limitDescription(d.settings.limits),'按各边界分别计数'],
          ...d.services.flatMap(s=>[['模型服务',s.name,limitDescription(s.limits),s.sharedCapacityId??'独立登记服务'],...s.mappings.map(m=>['服务模型',`${s.name} / ${modelName(m.definitionId)}`,limitDescription(m.limits),'共享所属服务上限'])]),
          ...d.pools.map(p=>['模型池',p.name,limitDescription(p.limits),'不增加来源服务容量']),
        ]}/></Panel>
      </Tabs>
    </details>
  </>;
}
