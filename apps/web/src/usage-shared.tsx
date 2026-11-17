import { useEffect, useRef, useState } from 'react';
import type { PlatformSnapshot, UsageAnalytics, UsageAnalyticsQuery, UsageBucket } from '@ai-gateway/contracts';
import { api } from './client';
import { usagePeriods, usagePeriodWindow, reportLocalTime, reportIsoTime, type UsagePeriod } from '@ai-gateway/contracts';
import { exportUsageCsv, exportUsageExcel } from './usage-export';
export { exportUsageCsv } from './usage-export';
import { DateField } from './date-field';
import { useNarrow } from './components';

/* Shared plumbing for 用量驾驶舱 and 排行榜: one query, one filter bar, one CSV
   writer, one set of number formatters. Two pages, one definition of "this window". */

export type UsageMetric='cost'|'tokens'|'requests';
export type UsageDimension='people'|'projects'|'applications'|'organizations';

export const usageMetricLabels:Record<UsageMetric,string>={cost:'已确认费用',tokens:'Token 用量',requests:'请求数'};
export const usageMetricSwitch:[UsageMetric,string][]=[['cost','费用'],['tokens','Token'],['requests','请求']];
export const usageFacts='按已结束调用统计，默认本月至今';

/* DateField speaks local `YYYY-MM-DDTHH:mm`; the endpoint speaks ISO timestamps. */
export const toLocal=reportLocalTime;
const toIso=reportIsoTime;

export const metricValue=(row:UsageBucket,metric:UsageMetric)=>metric==='cost'?row.confirmedAmount:metric==='tokens'?row.inputTokens+row.outputTokens:row.requests;
export const metricText=(row:UsageBucket,metric:UsageMetric)=>metric==='cost'?money(row.confirmedAmount):metric==='tokens'?`${((row.inputTokens+row.outputTokens)/1000000).toFixed(2)}M`:row.requests.toLocaleString('zh-CN');
export const money=(value:number)=>`¥ ${value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6})}`;

/* 占比不足 0.1% 时写「<0.1%」，接近满额时写「>99.9%」：
   有金额就绝不显示成 0%，也不把 99.97% 写成 100%。 */
export const percent=(part:number,whole:number)=>{
  if(!whole)return '—';
  const value=100*part/whole;
  if(value===0)return '0%';
  if(value<0.1)return '<0.1%';
  if(value>99.9&&value<100)return '>99.9%';
  return `${value.toFixed(1)}%`;
};
/* 待核对金额缺失时写「金额待定」，绝不用 ¥0 冒充免费。 */
export const pendingText=(count:number,amount:number)=>count===0?'无':amount>0?`${count} 条 · ${money(amount)}`:`${count} 条 · 金额待定`;

export const emptyBucket:UsageBucket={key:'',requests:0,unknownUsage:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,confirmedAmount:0,pendingReview:0,pendingAmount:0,errors:0,forwarded:0,upstreamFailures:0,lastActiveAt:null};

/** Rankings use directory members; activity uses the same currently entitled cohort as its denominator. */
export function usagePeople(data:PlatformSnapshot,rows:UsageBucket[]){
  const members=new Set(data.members.map(member=>member.id));
  const people=rows.filter(row=>members.has(row.key)),unknownSubjects=rows.filter(row=>!members.has(row.key));
  const entitled=new Set(data.entitlements.filter(entry=>members.has(entry.memberId)&&entry.status==='active'&&Date.parse(entry.expiresAt)>Date.now()).map(entry=>entry.memberId));
  const activeCount=people.filter(row=>entitled.has(row.key)).length;
  return {people,unknownSubjects,entitled,activeCount,inactiveCount:entitled.size-activeCount};
}

/* 趋势按自然日展开：没有调用的那天是真实的 0，而不是把相邻两天并成一段等距折线。 */
export function calendarDays(from:string,to:string,timezone:string){
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const last=new Date(Date.parse(to)-1);
  const start=format.format(new Date(from)),end=format.format(last);
  const days:string[]=[];
  const cursor=new Date(`${start}T00:00:00Z`),limit=new Date(`${end}T00:00:00Z`);
  while(cursor<=limit&&days.length<400){days.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1);}
  return days;
}

export interface UsageNames {
  member:(id:string)=>string|undefined;
  application:(id:string)=>string|undefined;
  project:(id:string)=>string;
  organization:(id:string)=>string;
  model:(id:string)=>string;
  service:(id:string)=>string;
  subject:(id:string)=>string;
}
export function usageNames(data:PlatformSnapshot):UsageNames{
  const member=(id:string)=>data.members.find(item=>item.id===id)?.name;
  const application=(id:string)=>data.applications.find(item=>item.id===id)?.name;
  return {
    member,application,
    service:(id:string)=>data.services.find(item=>item.id===id)?.name??(id||'未选定 / 历史未知'),
    project:(id:string)=>data.projects.find(item=>item.id===id)?.name??(id?'未匹配项目':'未归属项目'),
    organization:(id:string)=>data.organizations.find(item=>item.id===id)?.name??(id?'未匹配组织':'未归属组织'),
    model:(id:string)=>data.definitions.find(item=>item.modelId===id)?.name??id,
    subject:(id:string)=>member(id)??application(id)??'未识别身份',
  };
}

const filterDefaults={from:'',to:'',organizationId:'',modelId:'',purpose:'',projectId:'',applicationId:'',serviceId:''};
export type UsageFilters=typeof filterDefaults;

export interface UsageQuery {
  appliedQuery:UsageAnalyticsQuery;
  filters:UsageFilters;
  filter:(key:keyof UsageFilters,value:string)=>void;
  report:UsageAnalytics|null;
  error:string;
  busy:boolean;
  notice:string;
  setNotice:(value:string)=>void;
  search:()=>void;
  clear:()=>void;
  /** 快捷窗口：null = 本月至今（服务端默认），数字 = 最近 N 天。 */
  period:UsagePeriod|'custom';
  range:(period:UsagePeriod|'custom')=>void;
}
export function useUsageQuery(active:boolean):UsageQuery{
  const [filters,setFilters]=useState(filterDefaults);
  const [period,setPeriod]=useState<UsagePeriod|'custom'>('month');
  const [query,setQuery]=useState<UsageAnalyticsQuery>({});
  const resolved=useRef<{query:UsageAnalyticsQuery;value:UsageAnalyticsQuery}|null>(null);
  const [report,setReport]=useState<UsageAnalytics|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');

  useEffect(()=>{
    if(!active)return;
    let current=true;setBusy(true);setError('');setReport(null);setNotice('');
    void api<UsageAnalytics>('/api/v1/platform/analytics/usage',resolved.current?.query===query?resolved.current.value:query)
      .then(value=>{if(current){resolved.current={query,value:{...query,from:value.from,to:value.to}};setReport(value);}})
      .catch(failure=>{if(current){setReport(null);setError(failure instanceof Error?failure.message:'用量汇总读取失败');}})
      .finally(()=>{if(current)setBusy(false);});
    return()=>{current=false;};
  },[query,active]);
  /* 默认窗口由服务端按工作区时区给出（本月至今），这里把返回的窗口写回筛选器，
     让用户看到的日期就是这次统计真正用的日期。 */
  useEffect(()=>{
    if(!report)return;
    setFilters(previous=>previous.from&&previous.to?previous:{...previous,from:toLocal(new Date(report.from)),to:toLocal(new Date(report.to))});
  },[report]);

  return {
    appliedQuery:query,
    filters,
    filter:(key,value)=>{if(key==='from'||key==='to')setPeriod('custom');setFilters(previous=>({...previous,[key]:value}));},
    report,error,busy,notice,setNotice,
    search(){
      setReport(null);
      const {from,to}=period==='custom'?{from:toIso(filters.from),to:toIso(filters.to)}:usagePeriodWindow(period);
      if(period!=='custom'&&from&&to)setFilters(previous=>({...previous,from:toLocal(new Date(from)),to:toLocal(new Date(to))}));
      if((filters.from&&!from)||(filters.to&&!to)){setError('请选择完整的统计时间段。');return;}
      if(from&&to&&from>=to){setError('起始时间必须早于截止时间。');return;}
      setError('');setNotice('');
      setQuery({...Object.fromEntries(Object.entries(filters).filter(([key,value])=>key!=='from'&&key!=='to'&&!!value)),from,to} as UsageAnalyticsQuery);
    },
    clear(){setPeriod('month');setFilters(filterDefaults);setError('');setNotice('');setQuery({});},
    period,
    range(next){
      if(next==='custom'){setPeriod('custom');return;}
      const window=usagePeriodWindow(next);
      setPeriod(next);setNotice('');setError('');
      setFilters(previous=>({...previous,from:toLocal(new Date(window.from)),to:toLocal(new Date(window.to))}));
      const rest=Object.fromEntries(Object.entries(filters).filter(([key,value])=>key!=='from'&&key!=='to'&&!!value));
      setQuery({...rest,...window} as UsageAnalyticsQuery);
    },
  };
}

/** 两个页面共用的筛选区：默认窗口由服务端给出，CSV 导出跟随当前窗口。 */
export function UsageFilterBar({data,state,names}:{data:PlatformSnapshot;state:UsageQuery;names:UsageNames}){
  const {filters,filter,report,busy,notice,setNotice}=state;
  const [exporting,setExporting]=useState(false);
  const narrow=useNarrow(),[filtersOpen,setFiltersOpen]=useState(false);
  const download=async()=>{if(!report)return;setExporting(true);try{setNotice(await exportUsageExcel(report,names,state.appliedQuery));}catch{setNotice('Excel 导出失败，请重试或使用 CSV。');}finally{setExporting(false);}};
  return <>
    <form className="call-filters call-filter-form" aria-label="用量统计范围" onSubmit={event=>{event.preventDefault();state.search();}}>
      <div className="filter-primary">
        <label>常用时间<select aria-label="常用时间" value={state.period} disabled={busy} onChange={event=>{state.range(event.target.value as UsagePeriod|'custom');if(event.target.value==='custom')setFiltersOpen(true);}}>{usagePeriods.map(([id,label])=><option key={id} value={id}>{label}</option>)}<option value="custom">自定义</option></select></label>
      </div>
      {narrow&&<button type="button" className="ghost" aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(value=>!value)}>时间与对象筛选</button>}
      <div hidden={narrow&&!filtersOpen}><div className="filter-primary">
        <label>完成时间从<DateField value={filters.from} onChange={value=>filter('from',value)} mode="datetime" compact placeholder="默认本月 1 日 00:00"/></label>
        <label>完成时间至<DateField value={filters.to} onChange={value=>filter('to',value)} mode="datetime" compact placeholder="默认当前时间"/></label>
        <label>组织<select value={filters.organizationId} onChange={event=>filter('organizationId',event.target.value)}><option value="">全部组织</option>{data.organizations.map(organization=><option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
        <label>模型<select value={filters.modelId} onChange={event=>filter('modelId',event.target.value)}><option value="">全部模型</option>{data.definitions.map(definition=><option key={definition.id} value={definition.modelId}>{definition.name}</option>)}</select></label>
        <label>用途<select value={filters.purpose} onChange={event=>filter('purpose',event.target.value)}><option value="">全部用途</option><option value="personal">个人</option><option value="project">项目成员</option><option value="application">独立应用</option></select></label>
      </div>
      <details className="disclosure"><summary>项目、应用与服务来源</summary><div className="filter-more">
        <label>项目<select value={filters.projectId} onChange={e=>filter('projectId',e.target.value)}><option value="">全部项目</option>{data.projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>应用<select value={filters.applicationId} onChange={e=>filter('applicationId',e.target.value)}><option value="">全部应用</option>{data.applications.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {data.actor.roles.includes('operator')&&<label>服务来源<select value={filters.serviceId} onChange={e=>filter('serviceId',e.target.value)}><option value="">全部服务</option>{data.services.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      </div></details></div>
      <div className="filter-actions">
        <span className="filter-state">{usageFacts} · 筛选作用于本页所有维度</span>
        <button type="button" className="ghost" disabled={busy} onClick={state.clear}>清除筛选</button>
        <button type="button" className="ghost" disabled={!report||busy||!!state.error} onClick={()=>{if(report&&!busy&&!state.error)setNotice(exportUsageCsv(report,names,state.appliedQuery));}}>导出 CSV</button>
        <button type="button" className="ghost" disabled={!report||busy||exporting||!!state.error} onClick={()=>void download()}>{exporting?'正在导出…':'导出 Excel'}</button>
        <button className="primary" disabled={busy}>{busy?'查询中…':'查询'}</button>
      </div>
    </form>
    {(state.error||busy)&&<div className={state.error?'notice danger':'notice'} role={state.error?'alert':'status'}>{state.error?`${state.error} 当前数字不可用，请重试或检查采集。`:'正在读取用量汇总…'}</div>}
    {notice&&<div className="notice" role="status">{notice}</div>}
  </>;
}
