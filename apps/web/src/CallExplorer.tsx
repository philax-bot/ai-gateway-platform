import { useEffect,useId,useState,type ReactNode } from 'react';
import type { CallLog,CallPage,CallQuery,CallRelations,PlatformSnapshot } from '@ai-gateway/contracts';
import { api } from './client';
import { date,money,Panel,Status,Table,useNarrow } from './components';
import { DateField } from './date-field';

type Props={data:PlatformSnapshot;kind:'calls'|'reviews'|'overview';reconcile:(c:CallLog)=>void;detail:(title:string,content:ReactNode)=>void;initialQuery?:CallQuery;active?:boolean};
const emptyFilters={from:'',to:'',requestId:'',subjectId:'',modelId:'',serviceId:'',poolId:'',projectId:'',credentialId:'',purpose:'',outcome:'',billableState:''};
const outcomes:Record<string,string>={completed:'完成',upstream_error:'上游错误',timeout:'超时',client_cancelled:'客户端取消',partial:'流式 / 部分异常',rejected_before_upstream:'生成前拒绝'};
const purposeLabels:Record<string,string>={personal:'个人',project:'项目成员',application:'独立应用'};
export function CallExplorer({data:d,kind,reconcile,detail,initialQuery,active=true}:Props){
  const [initial]=useState<CallQuery>(()=>initialQuery??(kind==='reviews'?{billableState:'pending_review',limit:50}:{from:new Date(Date.now()-86400000).toISOString(),limit:50}));
  const [filters,setFilters]=useState(()=>{const f={...emptyFilters};for(const key of Object.keys(f) as (keyof typeof f)[]){const value=initial[key];if(value){if(key==='from'||key==='to'){const date=new Date(value);f[key]=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}else f[key]=value;}}return f;}),[query,setQuery]=useState<CallQuery>(initial);
  const [page,setPage]=useState<CallPage|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[previous,setPrevious]=useState<(string|undefined)[]>([]);
  const [advancedOpen,setAdvancedOpen]=useState(()=>Boolean(initial.subjectId||initial.serviceId||initial.poolId||initial.credentialId||initial.outcome||(kind!=='reviews'&&initial.billableState)));
  const [relatedRequest,setRelatedRequest]=useState<string|null>(null);
  const narrow=useNarrow(),filterId=useId(),[filtersOpen,setFiltersOpen]=useState(!narrow);
  useEffect(()=>{setFiltersOpen(!narrow);},[narrow]);
  const admin=d.actor.roles.includes('operator');
  useEffect(()=>{if(!active)return;let current=true;setBusy(true);setError('');void api<CallPage>('/api/v1/platform/calls/query',query).then(value=>{if(current)setPage(value);}).catch(e=>{if(current){setPage(null);setError(e instanceof Error?e.message:'日志采集失败');}}).finally(()=>{if(current)setBusy(false);});return()=>{current=false;};},[query,d,refresh,active]);
  const name=(id:string)=>d.members.find(m=>m.id===id)?.name??d.applications.find(a=>a.id===id)?.name??id;
  const model=(id:string)=>d.definitions.find(m=>m.modelId===id)?.name??id;
  async function openRelated(requestId:string){
    setRelatedRequest(requestId);
    try{
      const result=await api<CallRelations>(`/api/v1/platform/calls/${encodeURIComponent(requestId)}`);
      const rows=[...(result.original?[{relation:'原调用',call:result.original}]:[]),...result.retries.map(call=>({relation:'显式重试',call}))];
      detail('关联调用',<>
        <p className="secondary">关联关系只表示客户端显式重试。每次重试仍是新请求，独立授权、预占、计价和结算；同键重放不会重复调用上游。</p>
        {rows.length?<Table headers={['关系','请求 ID / 模型','结果','计费状态','上游请求号','完成时间']} rows={rows.map(({relation,call})=>[relation,<>{call.requestId.slice(0,32)}<small className="cell-help">{model(call.modelId)}</small></>,<Status value={call.outcome}/>,<Status value={call.billableState}/>,call.upstreamRequestId??'上游未提供',date(call.completedAt)])}/>:<div className="empty-state"><strong>没有可读取的关联调用</strong><p>原调用或重试记录不在当前职责范围，或尚未结束。读取遵守当前账号的对象范围。</p></div>}
        {result.original?.retryOfRequestId&&<p className="secondary">原调用还关联到更早的一次调用 <code>{result.original.retryOfRequestId}</code>。</p>}
      </>);
    }catch(e){detail('关联调用',<div className="notice danger" role="alert">关联调用读取失败：{e instanceof Error?e.message:'请稍后重试'}。</div>);}
    finally{setRelatedRequest(null);}
  }
  const field=(key:keyof typeof emptyFilters,value:string)=>setFilters(f=>({...f,[key]:value}));
  const emptyQuery=()=>({limit:50,...(kind==='reviews'?{billableState:'pending_review' as const}:{})});
  function search(){
    const next:Record<string,unknown>={limit:50};for(const [key,value] of Object.entries(filters)){if(!value)continue;next[key]=key==='from'||key==='to'?new Date(value).toISOString():value;}
    if(kind==='reviews')next.billableState='pending_review';setPrevious([]);setQuery(next as CallQuery);if(narrow)setFiltersOpen(false);
  }
  function clearFilters(){setFilters({...emptyFilters});setPrevious([]);setQuery(emptyQuery());}
  function clearRange(){setFilters(f=>({...f,from:'',to:''}));setPrevious([]);setQuery(current=>({...current,from:undefined,to:undefined,cursor:undefined}));}
  /* 下钻按“先结论、再接主体与路由、再用量与计价、最后时序”分组，长列表不再一次绗开。 */
  const show=(c:CallLog)=>detail('调用详情',<>
    <dl className="detail-lead">
      <div><dt>请求结果</dt><dd>{c.errorCode==='safety_policy_violation'?'被安全策略拦截':outcomes[c.outcome]}</dd></div>
      <div><dt>计费状态</dt><dd><Status value={c.billableState}/></dd></div>
      <div><dt>实际费用</dt><dd>{c.billableState==='pending_review'?'待核对':money(c.actualAmount)}</dd></div>
      <div><dt>完成时间</dt><dd>{date(c.completedAt)}</dd></div>
    </dl>
    {c.safety&&<p className="notice">输入规则命中 · {c.safety.action==='block'?'已拦截，未发送给模型、未扣费':'仅记录，按正常调用结算'} · 策略版本 {c.safety.policyVersion} · {c.safety.matches.map(m=>m.ruleId).join('、')}</p>}
    <div className="detail-groups">
      <section className="detail-group"><h3>主体与路由</h3><dl className="detail-list">{[
        ['主体',name(c.subjectId)],['用途',({personal:'个人',project:'项目成员',application:'独立应用'})[c.purpose]],['模型 / 协议',model(c.modelId)+(c.admission?.protocol?` · ${c.admission.protocol.requested} → ${c.admission.protocol.upstream}（${c.admission.protocol.mode==='native'?'原生透传':'Chat 适配'}）`:' · 协议历史未知')],['项目',d.projects.find(p=>p.id===c.projectId)?.name??c.projectId??'—'],
        ['密钥',d.keys.find(k=>k.credentialId===c.credentialId)?.masked??'历史或在线临时身份'],
        ['服务',d.services.find(s=>s.id===c.admission?.route?.serviceId)?.name??c.admission?.route?.serviceId??'未选定 / 历史未知'],
        ['模型池',d.pools.find(p=>p.id===c.admission?.route?.poolId)?.name??c.admission?.route?.poolId??'未选定 / 历史未知'],
        ['上游转发',c.forwarded===true?'已开始转发':c.forwarded===false?'未转发':'未知'],
      ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
      <section className="detail-group"><h3>用量与计价</h3><dl className="detail-list">{[
        ['用量完整性',c.usageFinal===true?'完整':'未知 / 不完整'],['输入 / 输出 / 缓存输入',c.usageFinal===true?`${c.inputTokens} / ${c.outputTokens} / ${c.cachedInputTokens}`:'未知'],
        ['实际费用',c.billableState==='pending_review'?'待核对（不代表免费）':money(c.actualAmount)],['预占金额',c.admission?money(c.admission.reservedAmount):c.reservationId?'历史未知':'未预占'],
        ['价格版本',c.admission?.price?.version??'历史模拟 / 未选定'],['输入 / 输出 / 缓存单价',c.admission?.price?`${c.admission.price.inputPrice} / ${c.admission.price.outputPrice} / ${c.admission.price.cachedInputPrice} 元 / 百万 Token`:'未知'],
      ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
      <section className="detail-group"><h3>时序与追踪</h3><dl className="detail-list">{[
        ['请求 ID',c.requestId],['上游请求号',c.upstreamRequestId??'上游未提供'],['关联原调用',c.retryOfRequestId??'无（不是显式重试）'],['错误码',c.errorCode??'未采集'],['预占 ID',c.reservationId??'未预占'],
        ['开始时间',date(c.startedAt)],['完成时间',date(c.completedAt)],['总时延',c.latencyMs==null?'未知':`${c.latencyMs} ms`],
      ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <div className="actions"><button className="link-button" disabled={relatedRequest===c.requestId} onClick={()=>void openRelated(c.retryOfRequestId??c.requestId)}>{relatedRequest===c.requestId?'正在读取…':c.retryOfRequestId?'查看原调用与重试':'查看关联调用'}</button></div>
      </section>
    </div>
    <p className="secondary">缓存输入是输入 Token 的子集。用量未知与零用量分别表达；待核对不代表免费。默认不保存和展示正文。</p>
  </>);
  const s=page?.summary,rate=(n:number,denominator:number)=>denominator?`${(100*n/denominator).toFixed(1)}%`:'证据不足';
  const advancedKeys=['credentialId','outcome',...(kind!=='reviews'?['billableState']:[]),...(admin?['subjectId','serviceId','poolId']:[])] as (keyof typeof emptyFilters)[];
  const advancedCount=advancedKeys.filter(key=>filters[key]).length;
  const activeCount=Object.entries(filters).filter(([key,value])=>value&&!(kind==='reviews'&&key==='billableState')).length;
  const refined=Object.entries(filters).some(([key,value])=>!!value&&key!=='from'&&key!=='to'&&!(kind==='reviews'&&key==='billableState'));
  const scope=<p className="secondary">统计基于当前筛选的全部已结束调用，包含已识别身份的授权拒绝；在途、未识别密钥和控制面未收到的请求不在分母内。{query.from?`起始：${date(query.from)}`:'起始：全部历史'}{query.to?` · 截止（不含）：${date(query.to)}`:''}</p>;
  const emptyState=refined
    ?<div className="empty-state"><strong>没有符合当前条件的调用</strong><p>已设置 {activeCount} 项筛选条件，当前范围内没有匹配的已结束调用。可以清除筛选，或放宽完成时间后再查。</p><div className="actions"><button className="ghost" onClick={clearFilters}>清除筛选</button></div></div>
    :kind==='reviews'
      ?<div className="empty-state"><strong>当前没有待核对的调用</strong><p>已结束调用都已核对完成。新的待核对记录会在出现时列在这里，可稍后刷新查看。</p></div>
      :<div className="empty-state"><strong>这段时间还没有调用记录</strong><p>当前查询范围内没有已结束的调用。同事发起调用后会出现在这里；也可以查看全部历史。</p><div className="actions"><button className="ghost" onClick={clearRange}>查看全部历史</button></div></div>;
  return <Panel title={kind==='reviews'?'待核对调用':kind==='overview'?'用量与费用汇总':'调用明细'} actions={<button className="ghost" disabled={busy} onClick={()=>setRefresh(n=>n+1)}>{busy?'正在读取…':'刷新记录'}</button>}>
    {narrow?<details className="disclosure"><summary>统计口径与查询范围</summary>{scope}</details>:scope}
    {narrow&&<div className="filter-summary"><button type="button" className="ghost" aria-expanded={filtersOpen} aria-controls={filterId} onClick={()=>setFiltersOpen(open=>!open)}>{filtersOpen?'收起筛选':'筛选'}{activeCount?` · ${activeCount} 项条件`:''}</button></div>}
    {(!narrow||filtersOpen)&&<form id={filterId} className="call-filters call-filter-form" onSubmit={event=>{event.preventDefault();search();}}>
      <div className="filter-primary">
        <label>完成时间从<DateField value={filters.from} onChange={value=>field('from',value)} mode="datetime" compact placeholder="不限起始时间"/></label><label>完成时间至<DateField value={filters.to} onChange={value=>field('to',value)} mode="datetime" compact placeholder="不限截止时间"/></label>
        {kind!=='overview'&&<label>请求 ID（精确）<input value={filters.requestId} onChange={e=>field('requestId',e.target.value)}/></label>}
        <label>模型<select value={filters.modelId} onChange={e=>field('modelId',e.target.value)}><option value="">全部</option>{d.definitions.map(m=><option key={m.id} value={m.modelId}>{m.name}</option>)}</select></label>
        <label>用途<select value={filters.purpose} onChange={e=>field('purpose',e.target.value)}><option value="">全部</option><option value="personal">个人</option><option value="project">项目成员</option><option value="application">应用</option></select></label>
        <label>项目<select value={filters.projectId} onChange={e=>field('projectId',e.target.value)}><option value="">全部</option>{d.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
      <details className="filter-more" open={advancedOpen} onToggle={event=>setAdvancedOpen(event.currentTarget.open)}>
        <summary>更多筛选{advancedCount?` · ${advancedCount} 项`:''}</summary>
        <div className="filter-more-grid">
          {admin&&<><label>主体<select value={filters.subjectId} onChange={e=>field('subjectId',e.target.value)}><option value="">全部</option>{[...d.members,...d.applications].map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>服务<select value={filters.serviceId} onChange={e=>field('serviceId',e.target.value)}><option value="">全部</option>{d.services.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>模型池<select value={filters.poolId} onChange={e=>field('poolId',e.target.value)}><option value="">全部</option>{d.pools.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label></>}
          <label>密钥<select value={filters.credentialId} onChange={e=>field('credentialId',e.target.value)}><option value="">全部 / 含在线身份</option>{d.keys.map(k=><option key={k.id} value={k.credentialId}>{k.name} · {k.masked}</option>)}</select></label>
          <label>结果<select value={filters.outcome} onChange={e=>field('outcome',e.target.value)}><option value="">全部</option>{Object.entries(outcomes).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label>
          {kind!=='reviews'&&<label>计费状态<select value={filters.billableState} onChange={e=>field('billableState',e.target.value)}><option value="">全部</option><option value="confirmed">已确认</option><option value="pending_review">待核对</option><option value="not_billable">不计费</option></select></label>}
        </div>
      </details>
      <div className="filter-actions">
        <span className="filter-state">{activeCount?`已设置 ${activeCount} 项条件`:'未设置筛选条件'}</span>
        <button type="button" className="ghost" disabled={busy} onClick={clearFilters}>清除筛选</button>
        <button className="primary" disabled={busy}>{busy?'查询中…':'查询'}</button>
      </div>
    </form>}
    {error&&<div className="notice danger" role="alert">采集失败：{error}。当前没有可用汇总，不能据此判断服务健康。</div>}
    {s&&<><div className="metric-grid">{[['已结束请求',s.ended,''],['确认费用',money(s.confirmedAmount),''],['待核对',s.pendingReview,s.pendingReview>0?'is-alert':''],['用量未知',s.unknownUsage,s.unknownUsage>0?'is-alert':'']].map(([label,value,tone])=><article className={`metric ${tone}`} key={String(label)}><span>{label}</span><strong>{value}</strong></article>)}</div>
      {narrow?<details className="disclosure"><summary>指标口径与错误率明细</summary><p className="secondary">已知用量 {s.knownUsage} 条：输入 {s.inputTokens} / 输出 {s.outputTokens} / 缓存输入 {s.cachedInputTokens}。活跃人员 {s.activeUsers} / 项目 {s.activeProjects} / 应用 {s.activeApplications}。</p><p className="secondary">请求错误率 {rate(s.errors,s.ended)}（{s.errors}/{s.ended}，取消单列 {s.cancelled}）；上游故障率 {rate(s.upstreamFailures,s.forwarded)}（{s.upstreamFailures}/{s.forwarded} 已转发且已结束）。超时 {s.timeouts} · 部分异常 {s.partial} · 生成前拒绝 {s.rejected} · 转发状态未知 {s.unknownForwarding}。</p></details>:<><p className="secondary">已知用量 {s.knownUsage} 条：输入 {s.inputTokens} / 输出 {s.outputTokens} / 缓存输入 {s.cachedInputTokens}。活跃人员 {s.activeUsers} / 项目 {s.activeProjects} / 应用 {s.activeApplications}。</p>
      <p className="secondary">请求错误率 {rate(s.errors,s.ended)}（{s.errors}/{s.ended}，取消单列 {s.cancelled}）；上游故障率 {rate(s.upstreamFailures,s.forwarded)}（{s.upstreamFailures}/{s.forwarded} 已转发且已结束）。超时 {s.timeouts} · 部分异常 {s.partial} · 生成前拒绝 {s.rejected} · 转发状态未知 {s.unknownForwarding}。</p></>}
      <small className="secondary">读取于 {date(page!.collectedAt)}；按需刷新。无流量表示证据不足。</small>
    </>}
    {kind!=='overview'&&page&&<><Table headers={['请求 ID / 模型','主体 / 用途','结果 / 错误码','输入 / 输出 / 缓存','实际费用 / 预占','计费状态','完成时间',...(kind==='reviews'?['操作']:[])]} empty={emptyState} rows={page.items.map(c=>[
      <><button className="link-button code-button" onClick={()=>show(c)}>{c.requestId.slice(0,24)}</button><small className="cell-help">{model(c.modelId)}</small></>,<>{name(c.subjectId)}<small className="cell-help">{purposeLabels[c.purpose]??c.purpose}</small></>,<><Status value={c.errorCode==='safety_policy_violation'?'已拦截':c.outcome}/><small className="cell-help">{c.errorCode??''}</small></>,c.usageFinal===true?`${c.inputTokens} / ${c.outputTokens} / ${c.cachedInputTokens}`:'未知 / 不完整',<>{c.billableState==='pending_review'?'待核对':money(c.actualAmount)}<small className="cell-help">预占 {c.admission?money(c.admission.reservedAmount):'未知'}</small></>,<Status value={c.billableState}/>,date(c.completedAt),...(kind==='reviews'?[<button className="link-button" onClick={()=>reconcile(c)}>核对并预览</button>]:[]),
    ])}/><div className="actions"><button disabled={busy||!previous.length} onClick={()=>{setQuery({...query,cursor:previous.at(-1)});setPrevious(p=>p.slice(0,-1));}}>上一页</button><span>第 {previous.length+1} 页 · 每页最多 50 条</span><button disabled={busy||!page.nextCursor} onClick={()=>{setPrevious(p=>[...p,query.cursor]);setQuery({...query,cursor:page.nextCursor!});}}>下一页</button></div></>}
  </Panel>;
}
