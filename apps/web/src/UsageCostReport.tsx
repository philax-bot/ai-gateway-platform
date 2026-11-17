import { useState } from 'react';
import type { UsageAnalytics, UsageBucket } from '@ai-gateway/contracts';
import { Panel, Table } from './components';
import { money, type UsageNames } from './usage-shared';

type Dimension='days'|'organizations'|'projects'|'applications'|'people'|'models'|'services';
const dimensions:[Dimension,string][]=[['days','逐日'],['organizations','组织'],['projects','项目'],['applications','应用'],['people','人员'],['models','模型'],['services','服务来源']];
export function UsageCostReport({report,names}:{report:UsageAnalytics;names:UsageNames}){
  const [dimension,setDimension]=useState<Dimension>('models');
  const cost=report.totals.cost;
  if(!cost)return null;
  const label=(row:UsageBucket)=>dimension==='days'?row.key:dimension==='organizations'?names.organization(row.key):dimension==='projects'?names.project(row.key):dimension==='applications'?names.application(row.key)??'未识别应用':dimension==='people'?names.subject(row.key):dimension==='models'?names.model(row.key):names.service(row.key);
  const costText=(row:UsageBucket)=>row.requests>0&&row.cost?.unknownRequests===row.requests?'未知':money(row.cost?.knownAmount??0);
  return <Panel title="计费与成本报表">
    <div className="metric-grid">
      <article className="metric"><span>已确认计费</span><strong>{money(report.totals.confirmedAmount)}</strong><small>不含待核对预占</small></article>
      <article className="metric"><span>已知估算成本</span><strong>{costText({...report.totals,key:'',lastActiveAt:null})}</strong><small>成本未知 {cost.unknownRequests} 条 · 非供应商账单</small></article>
      <article className="metric"><span>可比计费</span><strong>{cost.comparableRequests?money(cost.comparableBilledAmount):'—'}</strong><small>对应成本 {cost.comparableRequests?money(cost.comparableCostAmount):'—'} · 同批 {cost.comparableRequests} 条调用</small></article>
      <article className="metric"><span>可比差额</span><strong>{cost.comparableRequests?money(cost.differenceAmount):'—'}</strong><small>计费减估算成本，非财务利润</small></article>
    </div>
    <div className="call-filter-form"><div className="filter-primary"><label>报表维度<select aria-label="报表维度" value={dimension} onChange={e=>setDimension(e.target.value as Dimension)}>{dimensions.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></div></div>
    <Table headers={['主体','请求','已确认计费','已知估算成本','成本未知','可比计费 / 成本','可比差额']} rows={report[dimension].map(row=>[label(row),row.requests,money(row.confirmedAmount),costText(row),`${row.cost?.unknownRequests??row.requests} 条`,row.cost?.comparableRequests?`${money(row.cost.comparableBilledAmount)} / ${money(row.cost.comparableCostAmount)}`:'—',row.cost?.comparableRequests?money(row.cost.differenceAmount):'—'])} empty="当前范围没有调用，请调整时间或清除筛选。"/>
    <p className="secondary">成本价、倍率和计费价在调用准入时冻结，历史缺少成本依据的调用保留未知。输入 Token 已包含缓存输入，不重复相加。平台连接验证成本独立记录。</p>
  </Panel>;
}
