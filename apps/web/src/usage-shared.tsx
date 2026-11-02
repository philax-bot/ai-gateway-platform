import { useEffect, useState } from 'react';
import type { PlatformSnapshot, UsageAnalytics, UsageAnalyticsQuery, UsageBucket } from '@ai-gateway/contracts';
import { api } from './client';
import { DateField } from './date-field';

/* Shared plumbing for 用量驾驶舱 and 排行榜: one query, one filter bar, one CSV
   writer, one set of number formatters. Two pages, one definition of "this window". */

export type UsageMetric='cost'|'tokens'|'requests';
export type UsageDimension='people'|'projects'|'applications'|'organizations';

export const usageMetricLabels:Record<UsageMetric,string>={cost:'已确认费用',tokens:'Token 用量',requests:'请求数'};
export const usageMetricSwitch:[UsageMetric,string][]=[['cost','费用'],['tokens','Token'],['requests','请求']];
export const usageFacts='按已结束调用统计，默认本月至今';

/* DateField speaks local `YYYY-MM-DDTHH:mm`; the endpoint speaks ISO timestamps. */
export const toLocal=(value:Date)=>new Date(value.getTime()-value.getTimezoneOffset()*60000).toISOString().slice(0,16);
const toIso=(value:string)=>value?new Date(value).toISOString():undefined;

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
  subject:(id:string)=>string;
}
export function usageNames(data:PlatformSnapshot):UsageNames{
  const member=(id:string)=>data.members.find(item=>item.id===id)?.name;
  const application=(id:string)=>data.applications.find(item=>item.id===id)?.name;
  return {
    member,application,
    project:(id:string)=>data.projects.find(item=>item.id===id)?.name??(id?'未匹配项目':'未归属项目'),
    organization:(id:string)=>data.organizations.find(item=>item.id===id)?.name??(id?'未匹配组织':'未归属组织'),
    model:(id:string)=>data.definitions.find(item=>item.modelId===id)?.name??id,
    subject:(id:string)=>member(id)??application(id)??'未识别身份',
  };
}

const filterDefaults={from:'',to:'',organizationId:'',modelId:'',purpose:''};
export type UsageFilters=typeof filterDefaults;

export interface UsageQuery {
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
  range:(days:number|null)=>void;
}
export function useUsageQuery(active:boolean):UsageQuery{
  const [filters,setFilters]=useState(filterDefaults);
  const [query,setQuery]=useState<UsageAnalyticsQuery>({});
  const [report,setReport]=useState<UsageAnalytics|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');

  useEffect(()=>{
    if(!active)return;
    let current=true;setBusy(true);setError('');setReport(null);setNotice('');
    void api<UsageAnalytics>('/api/v1/platform/analytics/usage',query)
      .then(value=>{if(current)setReport(value);})
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
    filters,
    filter:(key,value)=>setFilters(previous=>({...previous,[key]:value})),
    report,error,busy,notice,setNotice,
    search(){
      setReport(null);
      const from=toIso(filters.from),to=toIso(filters.to);
      if((filters.from&&!from)||(filters.to&&!to)){setError('请选择完整的统计时间段。');return;}
      if(from&&to&&from>=to){setError('起始时间必须早于截止时间。');return;}
      setError('');setNotice('');
      setQuery({from,to,organizationId:filters.organizationId||undefined,modelId:filters.modelId||undefined,purpose:(filters.purpose||undefined) as UsageAnalyticsQuery['purpose']});
    },
    clear(){setFilters(filterDefaults);setError('');setNotice('');setQuery({});},
    range(days){
      setNotice('');setError('');
      if(days===null){setFilters(filterDefaults);setQuery({});return;}
      const to=new Date(),from=new Date(to.getTime()-days*86400000);
      setFilters({...filterDefaults,from:toLocal(from),to:toLocal(to)});
      setQuery({from:from.toISOString(),to:to.toISOString()});
    },
  };
}

/** 导出当前窗口的全部维度：长表 + 一个「维度」列，未知金额留空而不是写 0。 */
export function exportUsageCsv(report:UsageAnalytics,names:UsageNames){
  const rows:string[][]=[['维度','主体','主体标识','请求数','未知用量记录','输入Token','输出Token','缓存输入Token','已确认费用','待核对记录','待核对金额','异常','已转发','上游故障','最近活跃']];
  const amountCell=(value:number)=>value>0?String(Number(value.toFixed(6))):'0';
  const push=(label:string,key:string,row:UsageBucket,display:string)=>rows.push([label,display,key,String(row.requests),String(row.unknownUsage),String(row.inputTokens),String(row.outputTokens),String(row.cachedInputTokens),
    amountCell(row.confirmedAmount),String(row.pendingReview),row.pendingReview===0?'0':(row.pendingAmount>0?amountCell(row.pendingAmount):''),String(row.errors),String(row.forwarded),String(row.upstreamFailures),row.lastActiveAt??'']);
  for(const row of report.people)push('人员',row.key,row,names.subject(row.key));
  for(const row of report.applications)push('应用',row.key,row,names.application(row.key)??'未识别应用');
  for(const row of report.projects)push('项目',row.key,row,names.project(row.key));
  for(const row of report.models)push('模型',row.key,row,names.model(row.key));
  for(const row of report.organizations)push('组织',row.key,row,names.organization(row.key));
  for(const row of report.days)push('自然日',row.key,row,row.key);
  push('合计','',{...emptyBucket,...report.totals},'全部');
  const csv=rows.map(cells=>cells.map(cell=>/[",\r\n]/.test(cell)?`"${cell.replaceAll('"','""')}"`:cell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([`\ufeff${csv}`],{type:'text/csv;charset=utf-8'}));
  const windowDays=calendarDays(report.from,report.to,report.timezone);
  const anchor=document.createElement('a');anchor.href=url;anchor.download=`用量驾驶舱-${windowDays[0]??report.from.slice(0,10)}-${windowDays.at(-1)??report.to.slice(0,10)}.csv`;
  document.body.append(anchor);anchor.click();anchor.remove();URL.revokeObjectURL(url);
  return `已导出 ${rows.length-1} 行 CSV（窗口 ${windowDays[0]} 至 ${windowDays.at(-1)}，按 ${report.timezone} 切分）。`;
}

/** 两个页面共用的筛选区：默认窗口由服务端给出，CSV 导出跟随当前窗口。 */
export function UsageFilterBar({data,state,names}:{data:PlatformSnapshot;state:UsageQuery;names:UsageNames}){
  const {filters,filter,report,busy,notice,setNotice}=state;
  return <>
    <form className="call-filters call-filter-form" aria-label="用量统计范围" onSubmit={event=>{event.preventDefault();state.search();}}>
      <div className="filter-primary">
        <label>完成时间从<DateField value={filters.from} onChange={value=>filter('from',value)} mode="datetime" compact placeholder="默认本月 1 日 00:00"/></label>
        <label>完成时间至<DateField value={filters.to} onChange={value=>filter('to',value)} mode="datetime" compact placeholder="默认当前时间"/></label>
        <label>组织<select value={filters.organizationId} onChange={event=>filter('organizationId',event.target.value)}><option value="">全部组织</option>{data.organizations.map(organization=><option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
        <label>模型<select value={filters.modelId} onChange={event=>filter('modelId',event.target.value)}><option value="">全部模型</option>{data.definitions.map(definition=><option key={definition.id} value={definition.modelId}>{definition.name}</option>)}</select></label>
        <label>用途<select value={filters.purpose} onChange={event=>filter('purpose',event.target.value)}><option value="">全部用途</option><option value="personal">个人</option><option value="project">项目成员</option><option value="application">独立应用</option></select></label>
      </div>
      <div className="filter-actions">
        <span className="filter-state">{usageFacts} · 筛选作用于本页所有维度</span>
        <button type="button" className="ghost" disabled={busy} onClick={state.clear}>清除筛选</button>
        <button type="button" className="ghost" disabled={!report||busy||!!state.error} onClick={()=>{if(report&&!busy&&!state.error)setNotice(exportUsageCsv(report,names));}}>导出 CSV</button>
        <button className="primary" disabled={busy}>{busy?'查询中…':'查询'}</button>
      </div>
    </form>
    {(state.error||busy)&&<div className={state.error?'notice danger':'notice'} role={state.error?'alert':'status'}>{state.error?`${state.error} 当前数字不可用，请重试或检查采集。`:'正在读取用量汇总…'}</div>}
    {notice&&<div className="notice" role="status">{notice}</div>}
  </>;
}
