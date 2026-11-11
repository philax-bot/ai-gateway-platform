import {useState} from 'react';
import type {ModelService,VerificationRun,VerificationRunPage} from '@ai-gateway/contracts';
import {summarizeVerification,modelProtocols} from '@ai-gateway/contracts';
import {api} from './client';
import {date,money,Panel,Status,Table} from './components';
import {entryReadiness} from './model-readiness';
import type {PageProps} from './WorkspacePages';

export function ModelSetup({data:d,edit,setPage,refresh,detail}:Pick<PageProps,'data'|'edit'|'setPage'|'refresh'|'detail'>){
  const [checking,setChecking]=useState<string|null>(null),[error,setError]=useState<{id:string;message:string;validation:boolean}|null>(null),[lastRun,setLastRun]=useState<VerificationRun|null>(null);
  const definitions=d.definitions.filter(m=>m.active);
  const services=d.services.filter(s=>s.active&&s.mappings.some(m=>definitions.some(def=>def.id===m.definitionId)));
  const priced=services.filter(s=>s.verification==='passed'&&s.mappings.some(m=>definitions.some(def=>def.id===m.definitionId)&&[m.inputPrice,m.outputPrice,m.cachedInputPrice].every(p=>p!==null)));
  const opened=new Set(d.pools.flatMap(p=>p.entries.filter(e=>!entryReadiness(d,e)).map(e=>e.definitionId)));
  const incomplete=services.find(s=>s.verification==='passed'&&s.mappings.some(m=>definitions.some(def=>def.id===m.definitionId)&&[m.inputPrice,m.outputPrice,m.cachedInputPrice].some(p=>p===null))),unverified=services.find(s=>s.verification!=='passed');
  const step=!definitions.length?0:!priced.length?1:!opened.size?2:3;
  const service=unverified??incomplete;
  const existingPool=d.pools.find(p=>p.entries.some(e=>priced.some(s=>s.id===e.serviceId)))??d.pools[0];
  const failure=error&&(!error.validation||d.services.find(s=>s.id===error.id)?.verification!=='passed')?error:null;
  const connectionStatus=(value:string)=>value==='failed'?<span className="tag danger">连接未通过</span>:<Status value={value}/>;
  async function verify(id:string){
    setChecking(id);setError(null);
    try{
      const result=await api<ModelService&{verificationRun:VerificationRun;verificationApplied:boolean;replayed:boolean}>(`/api/v1/platform/services/${encodeURIComponent(id)}/verify`,{});
      if(!await refresh())throw new Error('连接验证已结束，但页面数据未更新，请刷新后查看结果。');
      setLastRun(result.verificationRun);
      if(!result.verificationApplied)setError({id,message:'验证期间服务配置已变更；本次结果保留为旧版本诊断记录，未写为当前配置已通过。请按当前配置重新验证。',validation:false});
      else if(result.verification!=='passed')setError({id,message:result.verificationMessage||'连接未通过，请检查地址、凭据引用和上游模型标识。',validation:true});
    }catch(e){setError({id,message:e instanceof Error?e.message:'验证失败，请重试。',validation:false});}finally{setChecking(null);}
  }
  const runText=(run:VerificationRun)=>{
    const s=summarizeVerification(run);
    const cost=s.internalCost===null?(s.costUnknown>0?'内部成本未知（用量或价格缺失）':'内部成本待确认'):money(s.internalCost);
    return `${run.state==='running'?'验证进行中':run.state==='interrupted'?'验证中断，用量待确认':'验证结束'} · 通过 ${s.passed} / 未通过 ${s.failed} · ${cost}`;
  };
  function showRun(run:VerificationRun){
    const s=summarizeVerification(run);
    detail('连接验证运行明细',<>
      <dl className="detail-list">
        <div><dt>运行 ID</dt><dd><code>{run.id}</code></dd></div>
        <div><dt>服务与配置版本</dt><dd>{run.serviceName} · v{run.configVersion}</dd></div>
        <div><dt>运行状态</dt><dd><Status value={run.state}/></dd></div>
        <div><dt>开始 / 结束</dt><dd>{date(run.startedAt)} / {run.completedAt?date(run.completedAt):'进行中'}</dd></div>
        <div><dt>内部诊断成本</dt><dd>{s.internalCost===null?'未知（用量或价格缺失）':money(s.internalCost)}</dd></div>
      </dl>
      <Table headers={['模型 / 协议','支持情况','上游请求号','用量','内部成本','说明']} rows={run.mappings.flatMap(mapping=>(mapping.protocols??['chat']).map(protocol=>{
        const result=run.results.find(value=>value.definitionId===mapping.definitionId&&(value.protocol??'chat')===protocol),usage=result?.usage;
        return [<>{modelName(mapping.definitionId)}<small className="cell-help">{protocol==='chat'?'Chat Completions':protocol==='responses'?'Responses':'Messages'}</small></>,result?<span className={'tag '+(result.support==='supported'||(!result.support&&result.outcome==='passed')?'success':'warning')}>{result.support==='supported'||(!result.support&&result.outcome==='passed')?'基础已支持':result.support==='unsupported'?'此入口不支持':'未确认'}</span>:mapping.attemptedAt?'已发出，结果未知':'未执行',result?.upstreamRequestId??'上游未提供',usage?.complete?`${usage.inputTokens} / ${usage.outputTokens} / ${usage.cachedInputTokens}`:'未知',result?result.cost.state==='priced'&&result.cost.amount!==null?money(result.cost.amount):result.cost.state==='price_unknown'?'价格未知':'用量未知':'—',result?.message??(mapping.attemptedAt?'进程中断，已发出的请求用量待确认':'未发出请求')];
      }))}/>
      {run.note&&<p className="notice warning">{run.note}</p>}
      <p className="secondary">价格使用验证时的模型映射快照计算，仅为平台内部成本估算，不是厂商账单或财务结算。</p>
    </>);
  }
  async function history(id:string){
    try{
      const page=await api<VerificationRunPage>(`/api/v1/platform/services/${encodeURIComponent(id)}/verifications?limit=20`);
      detail('连接验证记录',<>
        <p className="secondary">诊断流量由平台承担内部成本，不扣人员、项目或应用额度，也不计入员工调用统计和业务告警分母。</p>
        <Table headers={['开始时间','运行状态','通过 / 未通过','内部成本','配置版本','']} rows={page.items.map(run=>{const s=summarizeVerification(run);return [date(run.startedAt),<Status value={run.state}/>,`${s.passed} / ${s.failed}`,s.internalCost===null?'未知':money(s.internalCost),`v${run.configVersion}`,<button className="link-button" onClick={()=>showRun(run)}>逐模型 / 协议明细</button>];})} empty="还没有验证记录。验证连接后会在这里保留运行与用量证据。"/>
        {page.nextBefore&&<p className="secondary">仅显示最近 20 次；更早记录可按游标分页查询。</p>}
      </>);
    }catch(e){detail('连接验证记录',<div className="notice danger" role="alert">验证记录读取失败：{e instanceof Error?e.message:'请稍后重试'}。</div>);}
  }
  const titles=[d.definitions.length?'先启用一个要提供的模型':'先登记一个要提供的模型','下一步：接通模型并确认价格','连接已就绪，下一步开放使用范围',`已有 ${opened.size} 个模型接通并开放`];
  const descriptions=[d.definitions.length?'当前登记的模型均已停用。可以启用已有模型，或按需要登记新模型，再继续连接服务。':'填写同事看到的名称和调用时使用的模型标识。保存后继续连接提供该模型的服务。',incomplete?'已验证的服务仍有价格未确认。输入、输出和缓存输入价格都确认后，才能用于调用；免费明确填 0。':unverified?'服务已保存，验证连接后才能继续开放。测试会对每个映射分别发起三种协议的短请求，并记录诊断成本。':'填写服务地址、它提供的模型及价格。保存后验证连接，再继续开放。','把已接通的模型加入模型池并开放。模型池是一组可供开通方案、项目或应用选择的模型。','可以继续创建或选择人员开通方案。还可以按需要新增模型，已有配置在下方管理。'];
  const primary=()=>step===0?edit.definition(d.definitions[0]):step===1?incomplete?edit.service(incomplete):unverified?void verify(unverified.id):edit.service(undefined,definitions[0]?.id):step===2?edit.pool(existingPool):setPage('onboarding');
  const label=step===0?d.definitions.length?'启用已有模型':'登记第一个模型':step===1?incomplete?'确认模型价格':unverified?'验证模型连接':'连接模型服务':step===2?existingPool?'调整并开放模型':'创建模型池并开放':'下一步：为人员开通';
  const modelName=(id:string)=>d.definitions.find(m=>m.id===id)?.name??id;
  if(!d.actor.roles.includes('operator'))return <Panel title="模型服务"><p role="alert">模型服务仅供运营管理。</p><button className="ghost" onClick={()=>setPage('home')}>返回首页</button></Panel>;
  return <>
    <details className="disclosure" open={step<3||undefined}><summary>首次接入引导 · {step<3?'尚未完成':'已接通并开放'}</summary>
    <section className="panel task-hero"><span className="eyebrow">模型准备</span><h2>{titles[step]}</h2><p>{descriptions[step]}</p>
      <ol className="journey-steps" aria-label="模型准备进度">{['登记模型','连接与价格','开放使用范围'].map((s,i)=><li key={s} aria-current={step===i?'step':undefined}>{step>i?'✓':i+1} {s}</li>)}</ol>
      <div className="actions"><button className="primary" disabled={!!checking} onClick={primary}>{checking?'正在验证…':label}</button>{step===0&&!!d.definitions.length&&<button className="ghost" onClick={()=>edit.definition()}>登记新模型</button>}{step===1&&!incomplete&&unverified&&<button className="ghost" disabled={!!checking} onClick={()=>edit.service(unverified)}>修改服务配置</button>}{step===3&&<button className="ghost" onClick={()=>edit.service()}>接入另一个模型服务</button>}</div>
      {step===1&&service&&<p className="secondary">当前服务：{(incomplete??service).name} · {connectionStatus((incomplete??service).verification)}</p>}
    </section>
    </details>
    {failure&&<div className="notice danger" role="alert"><strong>模型连接尚未确认可用</strong><p>配置已保留。修改后可以重新验证。</p><button className="ghost" onClick={()=>{setError(null);edit.service(d.services.find(s=>s.id===failure.id));}}>修改本次服务配置</button><details><summary>查看验证详情</summary><p>{failure.message}</p></details></div>}
    {lastRun&&<div className={`notice ${lastRun.state==='completed'&&summarizeVerification(lastRun).failed===0?'':'warning'}`} role="status"><strong>最近一次连接验证</strong><p>{runText(lastRun)}。诊断流量由平台承担内部成本，不扣人员、项目或应用额度，也不计入员工调用统计。</p><button className="link-button" onClick={()=>showRun(lastRun)}>查看逐协议诊断</button></div>}
    <Panel title="模型服务" actions={<button className="primary" onClick={()=>edit.service()}>接入模型服务</button>}>
      <p className="secondary">在这里管理连接、模型映射与价格。验证通过且价格完整后，前往模型池开放使用。</p>
      <Table headers={['服务 / 提供模型','连接状态','价格确认','归属模型池','操作']} rows={d.services.map(s=>{
        const pool=d.pools.find(p=>p.entries.some(e=>e.serviceId===s.id));
        return [<>{s.name}<small className="cell-help">{s.baseUrl}</small><small className="cell-help">{s.mappings.map(m=>modelName(m.definitionId)).join('、')}</small></>,<>{connectionStatus(s.active?s.verification:'disabled')}<small className="cell-help">{s.verificationMessage}</small><small className="cell-help">{s.protocolCapabilities?.configVersion===s.configVersion?modelProtocols.map(p=>`${p==='chat'?'Chat':p==='responses'?'Responses':'Messages'} 原生基础通过 ${s.mappings.filter(m=>s.protocolCapabilities?.mappings[m.definitionId]?.[p]?.status==='supported').length}/${s.mappings.length}`).join(' · '):'三协议未探测：Responses / Messages 暂经 Chat 适配'}</small></>,`${s.mappings.filter(m=>[m.inputPrice,m.outputPrice,m.cachedInputPrice].every(p=>p!==null)).length} / ${s.mappings.length} 个模型`,pool?<button className="link-button" onClick={()=>edit.pool(pool)}>{pool.name}</button>:<button className="link-button" onClick={()=>setPage('pools')}>未入池 · 前往模型池</button>,<div className="inline-actions"><button disabled={!!checking} onClick={()=>edit.service(s)}>编辑服务与价格</button><button disabled={!!checking||!s.active} title={!s.active?'请先启用服务':undefined} onClick={()=>void verify(s.id)}>{checking===s.id?'正在验证…':'验证连接'}</button><button disabled={!!checking} onClick={()=>void history(s.id)}>验证记录</button></div>];
      })} empty="还没有模型服务。请先登记模型，再接入并验证服务。"/>
      <div className="actions"><button className="ghost" onClick={()=>setPage('catalog')}>查看模型目录</button><button className="ghost" onClick={()=>setPage('pools')}>管理模型池与开放范围</button><button className="ghost" onClick={()=>setPage('capacity')}>查看容量与保护</button></div>
    </Panel>
  </>;
}
