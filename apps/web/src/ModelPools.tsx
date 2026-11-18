import {Fragment,useEffect,useState,type FormEvent} from 'react';
import {hasPermission} from '@ai-gateway/contracts';
import {ROUTING_STRATEGIES,modelProviders,type CapacityMetric,type CapacityRow,type CapacitySnapshot,type ModelPool,type ModelKind,type PlatformSnapshot,type RoutingSimulation} from '@ai-gateway/contracts';
import {api} from './client';
import {Field,Panel,Status,Table,date,type FormValues} from './components';
import {entryReadiness} from './model-readiness';
import {CapacityMeter} from './model-surface';
import {RoutingDecisionView} from './RoutingDecision';
import {providerMark,markTint} from './provider-mark';
import type {PageProps} from './WorkspacePages';

type Props=Pick<PageProps,'data'|'edit'|'setPage'|'targetId'>;
const limitText=(value:ModelPool['limits'])=>value.mode==='inherit'?'继承企业默认':value.mode==='none'?'本级不额外限制':[['RPM',value.rpm],['TPM',value.tpm],['并发',value.concurrency],['单次输出 Token',value.maxOutputTokens]].filter(([,v])=>v!==undefined).map(([label,v])=>`${label} ${Number(v).toLocaleString('zh-CN')}`).join(' · ')||'未设置数值上限';
const percent=(metric:CapacityMetric)=>metric.percent===null?'—':`${metric.percent>=100?'≥100':Number(metric.percent.toFixed(1))}%`;
function capacityText(row:CapacityRow|undefined,unknown:boolean){
  if(unknown)return '未知';
  if(!row)return '无容量读数';
  return `RPM ${percent(row.rpm)} · TPM ${percent(row.tpm)} · 并发 ${percent(row.concurrency)}`;
}
const peakOf=(row:CapacityRow)=>Math.max(-1,...[row.rpm.percent,row.tpm.percent,row.concurrency.percent].filter((value):value is number=>value!==null));

export function ModelPools({data:d,edit,setPage,targetId}:Props){
  const [capacity,setCapacity]=useState<CapacitySnapshot|null>(null),[capacityError,setCapacityError]=useState('');
  useEffect(()=>{
    let live=true;
    void api<CapacitySnapshot>('/api/v1/platform/monitoring/capacity').then(result=>{if(!live)return;setCapacity(result);setCapacityError(result.quality==='collected'?'':'容量采集失败，当前占用未知。');}).catch(()=>{if(live){setCapacity(null);setCapacityError('暂时无法读取实时容量，当前占用未知。');}});
    return()=>{live=false;};
  },[d.revision]);
  if(!hasPermission(d.actor,'models.read'))return <Panel title="模型池"><p role="alert">模型池仅供运营管理。</p><button className="ghost" onClick={()=>setPage('home')}>返回首页</button></Panel>;
  const pool=targetId?d.pools.find(item=>item.id===targetId):undefined;
  if(pool)return <PoolDetails pool={pool} data={d} edit={edit} setPage={setPage} capacity={capacity} capacityError={capacityError}/>;
  return <>
    <PoolList data={d} edit={edit} setPage={setPage} capacity={capacity} capacityError={capacityError} staleId={targetId??null}/>
    <Panel title="默认模型池" actions={<button className="ghost" disabled={!hasPermission(d.actor,'administration.manage')} onClick={()=>edit.defaults()}>设置默认池</button>}>
      <dl className="detail-list"><div><dt>新个人方案默认池</dt><dd>{d.pools.find(item=>item.id===d.settings.personalDefaultPoolId)?.name??'未设置'}</dd></div><div><dt>新项目默认池</dt><dd>{d.pools.find(item=>item.id===d.settings.projectDefaultPoolId)?.name??'未设置'}</dd></div></dl>
      <p className="secondary">仅影响后续新建或审批预填，不迁移已有权益，不发放资金。</p>
    </Panel>
  </>;
}

function PoolList({data:d,edit,setPage,capacity,capacityError,staleId}:{data:PlatformSnapshot;edit:Props['edit'];setPage:Props['setPage'];capacity:CapacitySnapshot|null;capacityError:string;staleId:string|null}){
  const writable=hasPermission(d.actor,'models.write'),loading=!capacity&&!capacityError,unknown=!!capacityError||capacity?.quality!=='collected';
  const poolCapacity=(poolId:string)=>capacity?.rows.find(row=>row.kind==='pool'&&row.resourceId===poolId);
  const openModels=(pool:ModelPool)=>new Set(pool.entries.filter(entry=>entry.open).map(entry=>entry.definitionId));
  const readyModels=(pool:ModelPool)=>new Set(pool.entries.filter(entry=>!entryReadiness(d,entry)).map(entry=>entry.definitionId));
  const pendingEntries=d.pools.reduce((total,pool)=>total+pool.entries.filter(entry=>entry.open&&!!entryReadiness(d,entry)).length,0);
  const sourceStacks=(pool:ModelPool)=>{
    const providers=modelProviders(d.providers),ids=[...new Set(pool.entries.map(entry=>d.services.find(service=>service.id===entry.serviceId)?.providerId??'openai-compatible'))];
    return <span className="provider-cell-name">
      <span className="pool-stack" aria-hidden="true">{ids.slice(0,3).map(id=>{const provider=providers.find(item=>item.id===id),mark=providerMark(id,provider?.name??id);return <span className="provider-mark is-stacked" key={id} style={{background:markTint(mark.color),color:mark.color}}>{mark.label}</span>;})}</span>
      <span>{new Set(pool.entries.map(entry=>entry.serviceId)).size} 个服务<small className="cell-help">{new Set(pool.entries.map(entry=>entry.definitionId)).size} 个模型，其中 {readyModels(pool).size} 个就绪</small></span>
    </span>;
  };
  return <>
    {staleId&&<p className="notice warning">该模型池已不在你的权限范围或已被删除，已返回模型池列表。</p>}
    <Panel title="模型池与开放范围" actions={<button type="button" className="primary" disabled={!writable} onClick={()=>edit.pool()}>创建模型池</button>}>
      <p className="secondary">一个池可纳入多个模型服务，每个服务只归属一个池。同一模型的多个来源共同承接请求；新增来源默认暂不开放。</p>
      <div className="metric-grid">
        <article className="metric"><span>模型池</span><strong>{d.pools.length}</strong><small>默认池 {[d.settings.personalDefaultPoolId,d.settings.projectDefaultPoolId].filter(Boolean).length} 个</small></article>
        <article className="metric"><span>已开放模型</span><strong>{new Set(d.pools.flatMap(pool=>[...openModels(pool)])).size}</strong><small>按逻辑模型去重</small></article>
        <article className="metric"><span>来源服务</span><strong>{new Set(d.pools.flatMap(pool=>pool.entries.map(entry=>entry.serviceId))).size}</strong><small>已归属模型池的服务</small></article>
        <article className={`metric ${pendingEntries||capacityError?'is-alert':''}`}><span>待处理</span><strong>{pendingEntries}</strong><small>{pendingEntries?'已开放但来源未就绪':capacityError?'容量读数不可用':'当前没有阻塞来源'}</small></article>
      </div>
      {capacityError&&<p className="notice warning" role="status">{capacityError} 容量列显示未知，不使用旧读数。</p>}
      <Table headers={['模型池','策略 / 隔离','来源构成','开放模型','容量水位','默认','操作']} rows={d.pools.map(pool=>{
        const open=openModels(pool),ready=readyModels(pool),row=poolCapacity(pool.id),peak=row?peakOf(row):-1;
        return [
          <>{pool.name}<small className="cell-help">{pool.entries.length?`${pool.entries.filter(entry=>entry.open).length} 条来源开放`:'尚未纳入模型服务'}</small></>,
          <>{ROUTING_STRATEGIES[pool.routing?.strategy??'stable']}<small className="cell-help">{pool.routing?.failureThreshold?`连续 ${pool.routing.failureThreshold} 次故障隔离 ${pool.routing.cooldownSeconds} 秒`:'故障隔离关闭'}</small></>,
          sourceStacks(pool),
          <>{open.size} / {new Set(pool.entries.map(entry=>entry.definitionId)).size} 个<small className="cell-help">{ready.size} 个配置就绪</small></>,
          <>{capacityText(row,unknown)}<small className="cell-help">{loading?'正在读取容量…':unknown?'采集失败或读数已过期':row?`采集于 ${date(capacity!.collectedAt)}`:'尚未产生容量读数'}</small>{peak>=80&&!unknown&&<Status value={peak>=100?'failed':'pending'} label={peak>=100?'已满载':'接近上限'}/>}</>,
          <>{[d.settings.personalDefaultPoolId===pool.id?'个人':'',d.settings.projectDefaultPoolId===pool.id?'项目':''].filter(Boolean).join(' · ')||<span className="quiet-state">—</span>}</>,
          <button type="button" className="link-button" onClick={()=>setPage('pools',pool.id)}>详情 ›</button>,
        ];
      })} empty={<div className="empty-state"><strong>还没有模型池</strong><p>创建模型池并选择已接入的模型服务，再开放模型。一个服务只归属一个池。</p><div className="actions"><button type="button" className="ghost" disabled={!writable} onClick={()=>edit.pool()}>创建模型池</button></div></div>}/>
      <p className="secondary">可用数按模型去重，只表示配置就绪，不代表当前用户已获授权、拥有额度或上游实时健康。开放范围变更需预览关联影响，资金不会随模型变化转移。</p>
      <div className="actions"><button type="button" className="ghost" onClick={()=>setPage('models')}>管理模型服务</button><button type="button" className="ghost" onClick={()=>setPage('catalog')}>查看模型目录</button><button type="button" className="ghost" onClick={()=>setPage('capacity')}>容量与保护</button></div>
    </Panel>
  </>;
}

function PoolDetails({pool,data:d,edit,setPage,capacity,capacityError}:{pool:ModelPool;data:PlatformSnapshot;edit:Props['edit'];setPage:Props['setPage'];capacity:CapacitySnapshot|null;capacityError:string}){
  const [trial,setTrial]=useState<FormValues>({modelId:'',strategy:pool.routing?.strategy??'stable',requestId:crypto.randomUUID(),input:'0',output:'',units:''});
  const [weights,setWeights]=useState<FormValues>({});
  const [result,setResult]=useState<RoutingSimulation|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const writable=hasPermission(d.actor,'models.write'),unknown=!!capacityError||capacity?.quality!=='collected';
  const models=d.definitions.filter(definition=>pool.entries.some(entry=>entry.definitionId===definition.id));
  const modelId=String(trial.modelId||models[0]?.modelId||'');
  const entries=pool.entries.filter(entry=>entry.definitionId===models.find(model=>model.modelId===modelId)?.id);
  const row=(kind:CapacityRow['kind'],resourceId:string)=>capacity?.rows.find(item=>item.kind===kind&&item.resourceId===resourceId);
  const name=(id:string)=>d.definitions.find(model=>model.id===id)?.name??id;
  const serviceName=(id:string)=>d.services.find(service=>service.id===id)?.name??id;
  const weightFor=(entry:ModelPool['entries'][number],field:'weight'|'priority')=>String(weights[`${field}:${entry.serviceId}:${entry.definitionId}`]??entry[field]??(field==='weight'?1:0));
  function setField(key:string,value:string|string[]){setResult(null);setError('');setTrial(previous=>({...previous,[key]:value}));}
  async function simulate(event:FormEvent){
    event.preventDefault();if(busy||!models.length)return;
    const model=models.find(item=>item.modelId===modelId);
    if(!model)return;
    setBusy(true);setError('');setResult(null);
    try{
      const response=await api<RoutingSimulation>(`/api/v1/platform/pools/${encodeURIComponent(pool.id)}/simulate`,{
        modelId,requestId:String(trial.requestId||crypto.randomUUID()),estimatedInputTokens:Number(trial.input||0),
        ...(trial.output!==''?{maxOutputTokens:Number(trial.output)}:{}),...(trial.units!==''?{estimatedUnits:Number(trial.units)}:{}),
        routing:{strategy:String(trial.strategy) as NonNullable<ModelPool['routing']>['strategy'],failureThreshold:pool.routing?.failureThreshold??0,cooldownSeconds:pool.routing?.cooldownSeconds??30},
        entries:entries.map(entry=>({serviceId:entry.serviceId,weight:Number(weightFor(entry,'weight')),priority:Number(weightFor(entry,'priority'))})),
      });
      setResult(response);
    }catch(cause){setError(cause instanceof Error?cause.message:'试算失败，请稍后重试。');}finally{setBusy(false);}
  }
  const poolCapacity=row('pool',pool.id);
  const openModels=new Set(pool.entries.filter(entry=>entry.open).map(entry=>entry.definitionId));
  const services=[...new Set(pool.entries.map(entry=>entry.serviceId))];
  return <>
    <button type="button" className="link-button" onClick={()=>setPage('pools')}>← 返回模型池</button>
    <Panel title={pool.name} eyebrow="模型池" actions={<>
      <span className="tag">{ROUTING_STRATEGIES[pool.routing?.strategy??'stable']}</span>
      <button type="button" className="primary" disabled={!writable} onClick={()=>edit.pool(pool)}>调整并预览</button>
    </>}>
      <dl className="detail-lead">
        <div><dt>来源服务</dt><dd>{services.length}</dd></div>
        <div><dt>开放模型</dt><dd>{openModels.size} / {new Set(pool.entries.map(entry=>entry.definitionId)).size}</dd></div>
        <div><dt>故障隔离</dt><dd>{pool.routing?.failureThreshold?`${pool.routing.failureThreshold} 次 / ${pool.routing.cooldownSeconds}s`:'关闭'}</dd></div>
        <div><dt>默认池</dt><dd>{[d.settings.personalDefaultPoolId===pool.id?'个人':'',d.settings.projectDefaultPoolId===pool.id?'项目':''].filter(Boolean).join(' · ')||'非默认池'}</dd></div>
      </dl>
      <p className="secondary">同一模型的多个已开放来源共同承接请求，最终来源由准入在事务内锁定。权重与优先级决定候选顺序，容量与健康决定能否真正选中。</p>
      <h3>来源与候选</h3>
      <Table headers={['服务 / 模型','开放','顺序（权重 / 优先级）','服务状态','容量','操作']} rows={pool.entries.map(entry=>{
        const service=d.services.find(item=>item.id===entry.serviceId),readiness=entryReadiness(d,entry),serviceCapacity=row('service',entry.serviceId);
        return [
          <>{name(entry.definitionId)}<small className="cell-help">{serviceName(entry.serviceId)}</small></>,
          entry.open?readiness?<><Status value="pending" label="已开放未就绪"/><small className="cell-help">{readiness}</small></>:<Status value="active" label="已开放"/>:<span className="quiet-state">暂不开放</span>,
          `${entry.weight??1} / ${entry.priority??0}`,
          service?<>{service.active?<span className="quiet-state">启用</span>:<Status value="disabled"/>}<small className="cell-help">{service.verification==='passed'?'连接验证通过':service.verificationMessage||'尚未验证'}</small></>:<span className="quiet-state">服务不存在</span>,
          <span className="quiet-state">{capacityText(serviceCapacity,unknown)}</span>,
          <div className="inline-actions"><button type="button" disabled={!writable} onClick={()=>edit.pool(pool)}>调整</button><button type="button" onClick={()=>setPage('models')}>验证与记录</button></div>,
        ];
      })} empty="尚未加入模型服务。调整模型池以选择来源服务。"/>
      <h3>容量与保护上限</h3>
      {poolCapacity?<CapacityMeter rpm={poolCapacity.rpm} tpm={poolCapacity.tpm} concurrency={poolCapacity.concurrency} unknown={unknown} collectedAt={unknown?undefined:date(capacity!.collectedAt)}/>:<p className="secondary">{unknown?'实时容量未知：采集失败或尚未产生读数。':'该模型池还没有容量读数。'}</p>}
      <p className="secondary">池级保护：{limitText(pool.limits)}。一次请求需同时满足主体、用途、池、服务与共享容量等边界，本级不额外限制不会解除其他边界。调整入口在容量与保护。</p>
      <button type="button" className="link-button" onClick={()=>setPage('capacity')}>前往容量与保护 ›</button>
      <h3>路由解释与试算</h3>
      <p className="secondary">读取当前流量快照，给出候选排序、跳过原因与容量快照；不改变配置、不预占额度、不调用上游。</p>
      <form className="call-filter-form" onSubmit={event=>void simulate(event)}>
        <div className="filter-primary">
          <Field spec={{key:'trial-model',label:'试算模型',type:'select',required:true,options:models.map(model=>({value:model.modelId,label:model.name}))}} value={modelId} onChange={value=>setField('modelId',value)}/>
          <Field spec={{key:'trial-strategy',label:'拟议策略',type:'select',required:true,options:Object.entries(ROUTING_STRATEGIES).map(([value,label])=>({value,label}))}} value={String(trial.strategy)} onChange={value=>setField('strategy',value)}/>
          <Field spec={{key:'trial-request',label:'请求编号',required:true,help:'相同编号与快照产生相同分流序值。'}} value={String(trial.requestId)} onChange={value=>setField('requestId',value)}/>
          <Field spec={{key:'trial-input',label:'预估输入 Token',type:'number'}} value={String(trial.input)} onChange={value=>setField('input',value)}/>
          <Field spec={{key:'trial-output',label:'输出上限 Token（可选）',type:'number',help:'留空采用模型与入口保护上限。'}} value={String(trial.output)} onChange={value=>setField('output',value)}/>
        </div>
        <details className="disclosure"><summary>试用权重与优先级</summary>
          <div className="filter-more">{entries.map(entry=><Fragment key={entry.serviceId}>
            <Field spec={{key:`w-${entry.serviceId}`,label:`${serviceName(entry.serviceId)} · 权重`,type:'number',required:true}} value={weightFor(entry,'weight')} onChange={value=>setWeights(previous=>({...previous,[`weight:${entry.serviceId}:${entry.definitionId}`]:String(value)}))}/>
            <Field spec={{key:`p-${entry.serviceId}`,label:`${serviceName(entry.serviceId)} · 优先级`,type:'number',required:true,help:'数值越小越优先。'}} value={weightFor(entry,'priority')} onChange={value=>setWeights(previous=>({...previous,[`priority:${entry.serviceId}:${entry.definitionId}`]:String(value)}))}/>
          </Fragment>)}</div>
        </details>
        <div className="filter-actions">
          <span className="filter-state" role="status">{models.length?`候选 ${entries.length} 条来源 · 试算不写入配置`:'该池还没有可试算的模型'}</span>
          <button type="submit" className="ghost" disabled={busy||!models.length}>{busy?'正在试算…':'开始试算'}</button>
        </div>
      </form>
      {error&&<p className="notice danger" role="alert">{error}</p>}
      {result?<>
        <p className="notice" role="status">{result.notice}</p>
        <p className="secondary">试算请求 {result.requestId}{result.decision.sampledAt?` · 采样于 ${date(result.decision.sampledAt)}`:' · 历史快照未保留采样时间'}</p>
        <RoutingDecisionView decision={result.decision}/>
        <div className="actions"><button type="button" className="ghost" onClick={()=>setResult(null)}>重新试算</button></div>
      </>:<p className="secondary">还没有试算结果。试算结果只解释本次候选，不改变已冻结的其他请求。</p>}
      <h3>开放模型</h3>
      <Table headers={['模型','类型','来源与开放状态','就绪']} rows={[...new Set(pool.entries.map(entry=>entry.definitionId))].map(definitionId=>{
        const definition=d.definitions.find(model=>model.id===definitionId),related=pool.entries.filter(entry=>entry.definitionId===definitionId),ready=related.filter(entry=>!entryReadiness(d,entry));
        return [name(definitionId),definition?.kind?definition.kind as ModelKind:'chat',related.map(entry=><span key={entry.serviceId}>{serviceName(entry.serviceId)} · {entry.open?'开放':'未开放'}<small className="cell-help">{entryReadiness(d,entry)??'可承接请求'}</small></span>),ready.length?`${ready.length} 个来源就绪`:'暂无就绪来源'];
      })} empty="尚未纳入模型。"/>
      <p className="secondary">开放只表示池内可用范围；当前账号能否调用还取决于用途权益、模型范围与额度。金额与价格不受模型开放变更影响。</p>
    </Panel>
  </>;
}
