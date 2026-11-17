import {hasPermission} from '@ai-gateway/contracts';
import { useEffect, useMemo, useState } from 'react';
import type { CallQuery, PlatformSnapshot, UsageBucket } from '@ai-gateway/contracts';
import {usageTarget} from './usage-navigation';
import { Panel, Table, date } from './components';
import { ShareBar } from './components-charts';
import type { makeEditors } from './editors';
import { metricText, metricValue, money, pendingText, percent, usageMetricLabels, usageMetricSwitch, usageNames, useUsageQuery, UsageFilterBar, type UsageDimension, type UsageMetric } from './usage-shared';

type Props={data:PlatformSnapshot;active?:boolean;setPage:(page:string,id?:string)=>void;edit:ReturnType<typeof makeEditors>;targetId?:string|null};

const dimensions:[UsageDimension,string][]=[['people','人员'],['projects','项目'],['applications','应用'],['organizations','组织']];
const emptyCopy:Record<UsageDimension,string>={
  people:'窗口内没有可排名的已识别身份调用。未识别身份的调用在驾驶舱的数据质量里单列。',
  projects:'窗口内没有带项目归属的调用；个人与独立应用调用不属于任何项目。',
  applications:'窗口内没有独立应用发起的调用。应用接入并产生调用后会出现在这里。',
  organizations:'窗口内没有带组织归属的调用。',
};

export function UsageLeaderboard({data,active=true,setPage,edit,targetId}:Props){
  const query=useUsageQuery(active),names=usageNames(data);
  const initial=(dimensions.some(([value])=>value===targetId)?targetId:'people') as UsageDimension;
  const [dimension,setDimension]=useState<UsageDimension>(initial),[metric,setMetric]=useState<UsageMetric>('cost');
  useEffect(()=>{if(dimensions.some(([value])=>value===targetId))setDimension(targetId as UsageDimension);},[targetId]);
  const operator=hasPermission(data.actor,'usage.read.all'),managesProjects=data.projects.some(project=>project.managerId===data.actor.id&&project.status==='active');
  const report=query.report,totals=report?.totals;

  const memberOf=(id:string)=>data.members.find(member=>member.id===id);
  const applicationOf=(id:string)=>data.applications.find(application=>application.id===id);
  const projectOf=(id:string)=>data.projects.find(project=>project.id===id);
  const rows=useMemo<UsageBucket[]>(()=>{
    const source=dimension==='people'?report?.people:dimension==='projects'?report?.projects:dimension==='applications'?report?.applications:report?.organizations;
    return (source??[]).filter(row=>dimension==='people'?data.members.some(member=>member.id===row.key):dimension==='applications'?data.applications.some(application=>application.id===row.key):true).sort((a,b)=>metricValue(b,metric)-metricValue(a,metric));
  },[report,dimension,metric,data.members,data.applications]);

  const label=(row:UsageBucket)=>dimension==='people'?names.subject(row.key):dimension==='projects'?names.project(row.key):dimension==='applications'?(names.application(row.key)??'未识别应用'):names.organization(row.key);
  const rowQuery=(row:UsageBucket):CallQuery=>dimension==='people'?{subjectId:row.key,subjectType:'employee'}:dimension==='applications'?{subjectId:row.key,subjectType:'application'}:dimension==='projects'?{projectId:row.key}:{organizationId:row.key};
  const drill=(row:UsageBucket,extra:CallQuery={},reviews=false)=>{if(report&&operator)setPage(reviews?'reviews':'calls',usageTarget('leaderboard',label(row),report,{...query.appliedQuery,...rowQuery(row),...extra}));};
  const action=(row:UsageBucket)=>{
    if(!hasPermission(data.actor,'finance.write'))return null;
    if(dimension==='people'){if(!hasPermission(data.actor,'administration.manage'))return null;const member=memberOf(row.key);return member?<button className="link-button" onClick={()=>edit.grantPlan(undefined,member.id)}>调整额度</button>:'—';}
    if(dimension==='projects'){const project=projectOf(row.key);return project?<button className="link-button" onClick={()=>edit.fund('project',project)}>补充额度</button>:'—';}
    if(dimension==='applications'){const application=applicationOf(row.key);return application?application.billingMode==='accounting'?<button className="link-button" onClick={()=>setPage('applications',application.id)}>查看记账</button>:<button className="link-button" onClick={()=>edit.fund('application',application)}>追加额度</button>:'—';}
    return <button className="link-button" onClick={()=>setPage('members')}>成员</button>;
  };

  if(!operator&&!managesProjects)return <div className="usage-cockpit">
    <Panel title="需要运营或项目经理权限">
      <div className="empty-state">
        <strong>排行榜只对运营管理员与项目经理开放</strong>
        <p>运营管理员看全企业；项目经理只看自己管理项目下的项目用途调用。你自己的用量与额度在「我的额度」「调用记录」里。</p>
        <div className="actions"><button className="ghost" onClick={()=>setPage('quota')}>查看我的额度</button><button className="ghost" onClick={()=>setPage('calls')}>查看我的调用</button></div>
      </div>
    </Panel>
  </div>;

  const headers=operator?['排名','主体','请求数','输入 / 输出 Token','已确认费用','费用占比','异常','待核对','最近活跃','额度']:['排名','主体','请求数','输入 / 输出 Token','已确认费用','费用占比','异常','待核对','最近活跃'];

  return <div className="usage-cockpit usage-leaderboard">
    <UsageFilterBar data={data} state={query} names={names}/>
    <div className="section-tabs usage-dim-tabs" role="tablist" aria-label="排行榜维度">
      {dimensions.map(([value,text])=>(
        <button key={value} type="button" role="tab" aria-selected={dimension===value} className={dimension===value?'selected':''} onClick={()=>setDimension(value)}>
          {text} <span>{value==='people'?(report?.people.filter(row=>!!memberOf(row.key)).length??0):value==='projects'?(report?.projects.length??0):value==='applications'?(report?.applications.filter(row=>!!applicationOf(row.key)).length??0):(report?.organizations.length??0)}</span>
        </button>
      ))}
    </div>
    <Panel title={`${dimensions.find(([value])=>value===dimension)?.[1]}用量排名`} actions={<div className="section-tabs cockpit-seg" aria-label="排名口径">{usageMetricSwitch.map(([value,text])=><button key={value} type="button" className={metric===value?'selected':''} aria-pressed={metric===value} onClick={()=>setMetric(value)}>{text}</button>)}</div>}>
      <p className="secondary">{operator
        ? `按${usageMetricLabels[metric]}降序，排名只含已识别身份；费用只计已确认金额，Token 只计完整用量。未识别身份与未知用量在驾驶舱的数据质量里单列。`
        : `只包含你管理项目下的项目用途调用与你本人的调用；其他成员的个人用途调用不进入这里。按${usageMetricLabels[metric]}降序。`}</p>
      {operator&&dimension==='people'&&<p className="secondary">「调整额度」进入现有开通 / 追加流程，名单与金额仍需在预览里确认。</p>}
      <Table headers={headers} empty={<div className="empty-state"><strong>这个维度没有数据</strong><p>{emptyCopy[dimension]}</p><div className="actions"><button className="ghost" onClick={query.clear}>清除筛选</button></div></div>}
        rows={rows.map((row,index)=>{
          const member=dimension==='people'?memberOf(row.key):undefined;
          const cells=[String(index+1).padStart(2,'0'),
            <>{operator&&row.key?<button className="link-button" data-usage-drill={dimension} onClick={()=>drill(row)}>{label(row)}</button>:label(row)}{dimension==='people'&&member?<small className="cell-help">{member.directoryId} · {names.organization(member.organizationId)}</small>:row.key?null:<small className="cell-help">未归属</small>}</>,
            row.requests.toLocaleString('zh-CN'),
            `${row.inputTokens.toLocaleString('zh-CN')} / ${row.outputTokens.toLocaleString('zh-CN')}`,
            <>{money(row.confirmedAmount)}{row.pendingReview>0&&<small className="cell-help">待核对 {row.pendingReview} 条</small>}</>,
            <ShareBar ratio={totals?.confirmedAmount?row.confirmedAmount/totals.confirmedAmount:0} label={percent(row.confirmedAmount,totals?.confirmedAmount||0)}/>,
            <>{operator&&row.key?<button className="link-button" data-usage-drill="errors" disabled={!row.errors} onClick={()=>drill(row,{resultGroup:'errors'})}>{percent(row.errors,row.requests)}</button>:percent(row.errors,row.requests)}{row.forwarded>0&&<small className="cell-help">上游故障 {percent(row.upstreamFailures,row.forwarded)}</small>}</>,
            operator&&row.key?<button className="link-button" data-usage-drill="pending" disabled={!row.pendingReview} onClick={()=>drill(row,{billableState:'pending_review'},true)}>{pendingText(row.pendingReview,row.pendingAmount)}</button>:pendingText(row.pendingReview,row.pendingAmount),
            row.lastActiveAt?date(row.lastActiveAt):'—'];
          return operator?[...cells,action(row)]:cells;
        })}/>
      <p className="secondary">{rows.length} 行 · 合计见下方；排名不用于绩效评价。</p>
      <dl className="detail-list">
        <div><dt>已确认费用合计</dt><dd>{totals?money(totals.confirmedAmount):'—'}</dd></div>
        <div><dt>已结束请求合计</dt><dd>{totals?totals.requests.toLocaleString('zh-CN'):'—'}</dd></div>
        <div><dt>Token 合计</dt><dd>{totals?`${(totals.inputTokens/1000000).toFixed(2)}M / ${(totals.outputTokens/1000000).toFixed(2)}M`:'—'}</dd></div>
        <div><dt>待核对</dt><dd>{totals?pendingText(totals.pendingReview,totals.pendingAmount):'—'}</dd></div>
      </dl>
    </Panel>
    {operator&&<p className="secondary">当前排名口径 {usageMetricLabels[metric]}：第一名 {rows[0]?`${label(rows[0])} ${metricText(rows[0],metric)}`:'—'}。切换口径只改排序与分母，不改筛选与窗口。</p>}
  </div>;
}
