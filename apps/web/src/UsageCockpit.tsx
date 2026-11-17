import {hasPermission} from '@ai-gateway/contracts';
import { useMemo, useState } from 'react';
import type { CallQuery, PlatformSnapshot } from '@ai-gateway/contracts';
import {usageTarget} from './usage-navigation';
import { ChartEmpty, DonutChart, GaugeChart, ShareBar, TrendChart } from './components-charts';
import { date, Panel, Table } from './components';
import { UsageCostReport } from './UsageCostReport';
import type { makeEditors } from './editors';
import { calendarDays, emptyBucket, metricText, metricValue, money, pendingText, percent, usageMetricLabels, usageMetricSwitch, usageNames, usagePeople, useUsageQuery, UsageFilterBar, type UsageMetric } from './usage-shared';

type Dimension='organizations'|'projects'|'applications';
type Props={data:PlatformSnapshot;active?:boolean;setPage:(page:string,id?:string)=>void;edit:ReturnType<typeof makeEditors>};

const dimensionLabels:Record<Dimension,string>={organizations:'组织',projects:'项目',applications:'应用'};
const dimensionPage:Record<Dimension,string>={organizations:'organizations',projects:'projects',applications:'applications'};

export function UsageCockpit({data,active=true,setPage,edit}:Props){
  const query=useUsageQuery(active),names=usageNames(data);
  const [metric,setMetric]=useState<UsageMetric>('cost'),[dimension,setDimension]=useState<Dimension>('organizations');
  const operator=hasPermission(data.actor,'usage.read.all');
  const managesProjects=data.projects.some(project=>project.managerId===data.actor.id&&project.status==='active');

  const report=query.report,totals=report?.totals;
  const drill=(label:string,extra:CallQuery={},reviews=false)=>{if(report&&operator)setPage(reviews?'reviews':'calls',usageTarget('usage',label,report,{...query.appliedQuery,...extra}));};
  const memberOf=(id:string)=>data.members.find(member=>member.id===id);
  const applicationOf=(id:string)=>data.applications.find(application=>application.id===id);
  const projectOf=(id:string)=>data.projects.find(project=>project.id===id);
  const {people,unknownSubjects,entitled,activeCount,inactiveCount}=usagePeople(data,report?.people??[]);
  const unknownRequests=unknownSubjects.reduce((sum,row)=>sum+row.requests,0);
  const ranked=useMemo(()=>[...people].sort((a,b)=>metricValue(b,metric)-metricValue(a,metric)),[people,metric]);
  const top=ranked.slice(0,8),maxValue=Math.max(1,...top.map(row=>metricValue(row,metric)));
  const rest=ranked.slice(8);
  const restBucket=rest.reduce((sum,row)=>({...sum,requests:sum.requests+row.requests,inputTokens:sum.inputTokens+row.inputTokens,outputTokens:sum.outputTokens+row.outputTokens,confirmedAmount:sum.confirmedAmount+row.confirmedAmount}),{...emptyBucket});
  const metricTotal=metric==='cost'?(totals?.confirmedAmount??0):metric==='tokens'?((totals?.inputTokens??0)+(totals?.outputTokens??0)):totals?.requests??0;
  const models=report?.models??[];
  const modelSegments=models.slice(0,3).map(row=>({label:names.model(row.key),value:percent(row.confirmedAmount,totals?.confirmedAmount||0),ratio:totals?.confirmedAmount?row.confirmedAmount/totals.confirmedAmount:0,detail:money(row.confirmedAmount)}));
  const otherModels=models.slice(3);
  if(otherModels.length){
    const amount=otherModels.reduce((sum,row)=>sum+row.confirmedAmount,0);
    modelSegments.push({label:`其他 ${otherModels.length} 个模型`,value:percent(amount,totals?.confirmedAmount||0),ratio:totals?.confirmedAmount?amount/totals.confirmedAmount:0,detail:money(amount)});
  }
  const dayRows=new Map((report?.days??[]).map(row=>[row.key,row]));
  const trendKeys=report?calendarDays(report.from,report.to,report.timezone):[];
  const days=trendKeys.map(key=>dayRows.get(key)??{...emptyBucket,key});
  const trendPoints=days.map(row=>({label:row.key,primary:row.confirmedAmount,secondary:row.requests}));
  const hasData=!!report&&(totals?.requests??0)>0;
  const organizationRows=(report?.organizations??[]).filter(row=>row.key);
  const unattributed=(report?.organizations??[]).find(row=>!row.key);
  const dimensionRows=dimension==='organizations'?organizationRows:dimension==='projects'?(report?.projects??[]):(report?.applications??[]);
  const dimensionTotal=Math.max(1,...dimensionRows.map(row=>row.confirmedAmount));
  const dimensionName=(key:string)=>dimension==='organizations'?names.organization(key):dimension==='projects'?names.project(key):(names.application(key)??'未识别应用');

  if(!operator)return <div className="usage-cockpit">
    <Panel title="需要运营权限">
      <div className="empty-state">
        <strong>用量驾驶舱只对运营管理员开放</strong>
        <p>全企业的人员、项目与应用用量看板会暴露同事的支出，因此只给运营管理员。项目经理可以在「项目用量」里查看自己项目下的项目用途调用；你自己的用量与额度在「我的额度」「调用记录」里。</p>
        <div className="actions">
          {managesProjects&&<button className="ghost" onClick={()=>setPage('leaderboard','projects')}>查看项目用量</button>}
          <button className="ghost" onClick={()=>setPage('quota')}>查看我的额度</button>
          <button className="ghost" onClick={()=>setPage('calls')}>查看我的调用</button>
        </div>
      </div>
    </Panel>
  </div>;

  const qualityPanel=<Panel title="数据质量" actions={<button className="link-button" onClick={()=>setPage('monitoring')}>检查监控采集</button>}>
    <dl className="detail-list">
      <div><dt>采集状态</dt><dd>{query.error?'读取失败，当前数字不可用':query.busy&&!report?'正在读取…':'已采集'}</dd></div>
      <div><dt>最近读取</dt><dd>{report?date(report.collectedAt):'—'}</dd></div>
      <div><dt>用量未知记录</dt><dd>{totals?`${totals.unknownUsage} 条`:'—'}</dd></div>
      <div><dt>待核对记录</dt><dd>{totals?<button className="link-button" disabled={!totals.pendingReview} onClick={()=>drill('当前窗口待核对记录',{billableState:'pending_review'},true)}>{pendingText(totals.pendingReview,totals.pendingAmount)}</button>:'—'}</dd></div>
      <div><dt>未识别身份</dt><dd>{report?`${unknownRequests} 次请求 / ${unknownSubjects.length} 个主体`:'—'}</dd></div>
      <div><dt>本期无调用人员</dt><dd>{report?`${inactiveCount} 人`:'—'}</dd></div>
    </dl>
    <p className="secondary">未识别身份是历史调用中出现、但已不在成员目录里的主体；它们计入合计，不进入人员排名。采集失败时整页数字转为未知，不使用上一次读数冒充当前窗口。</p>
  </Panel>;

  const emptyPage=<Panel title="这段时间没有调用">
    <div className="empty-state">
      <strong>当前筛选下没有已结束的调用</strong>
      <p>窗口内没有符合组织、模型或用途条件的已结束调用。可以放宽时间范围或清除筛选后重新查询；在途调用不计入这里。</p>
      <div className="actions"><button className="ghost" onClick={query.clear}>清除筛选</button><button className="ghost" onClick={()=>setPage('calls')}>查看全部调用记录</button></div>
    </div>
  </Panel>;

  const cockpit=!report
    ?<Panel title={query.error?'用量汇总暂不可用':'正在读取用量汇总'}><p className="secondary">{query.error?'请重新查询或检查监控采集，当前窗口的数字与导出暂不可用。':'首次打开需要读取窗口内的已结束调用，读取完成后可切到排行榜逐人核对。'}</p></Panel>
    :<>
      <div className="metric-grid">
        <article className="metric"><span>活跃人员</span><strong>{activeCount}<small className="metric-unit">/ {entitled.size} 已开通</small></strong><small>当前有效开通人员中有调用的人数</small></article>
        <article className="metric"><span>已结束请求</span><strong><button className="link-button" data-usage-drill="all" onClick={()=>drill('当前窗口全部调用')}>{totals?totals.requests.toLocaleString('zh-CN'):'未知'}</button></strong><small>人均 {totals&&totals.activePeople?Math.round(totals.requests/totals.activePeople):'—'} 次 · <button className="link-button" data-usage-drill="errors" disabled={!totals?.errors} onClick={()=>drill('当前窗口异常调用',{resultGroup:'errors'})}>异常 {totals?.errors??0} 次</button></small></article>
        <article className="metric"><span>输入 / 输出 Token</span><strong>{totals?`${(totals.inputTokens/1000000).toFixed(2)}M / ${(totals.outputTokens/1000000).toFixed(2)}M`:'未知'}</strong><small>缓存输入 {(totals?totals.cachedInputTokens/1000000:0).toFixed(2)}M · 未知用量 {totals?.unknownUsage??0} 条未计入</small></article>
        <article className={`metric ${(totals?.pendingReview??0)>0?'is-alert':''}`}><span>待核对费用</span><strong><button className="link-button" data-usage-drill="pending" disabled={!totals?.pendingReview} onClick={()=>drill('当前窗口待核对记录',{billableState:'pending_review'},true)}>{!totals?'未知':totals.pendingReview===0?money(0):totals.pendingAmount>0?money(totals.pendingAmount):'金额待定'}</button></strong><small>{totals?.pendingReview??0} 条记录 · 待核对不代表免费</small></article>
      </div>

      <div className="cockpit-grid">
        <div className="cockpit-area-dist"><Panel title="模型用量分布" actions={<button className="link-button" onClick={()=>setPage('models')}>模型配置</button>}>
          {hasData&&modelSegments.length
            ?<DonutChart center={money(totals?.confirmedAmount??0)} centerLabel="已确认费用" label={`模型费用占比：${modelSegments.map(segment=>`${segment.label} ${segment.value}`).join('，')}`} segments={modelSegments}/>
            :<ChartEmpty>窗口内没有可比较的模型费用。放宽时间或清除模型筛选后再看。</ChartEmpty>}
          <p className="secondary">{models.length?`${models.length} 个模型合计与汇总一致。`:'当前窗口没有模型调用。'}占比按已确认金额计算；未配置价格的调用金额为 0，仍列在表中，不会被抹去。</p>
        </Panel></div>

        <div className="cockpit-area-rank"><Panel title="用户排名" actions={<>
          <div className="section-tabs cockpit-seg" aria-label="排名口径">{usageMetricSwitch.map(([value,label])=><button key={value} type="button" className={metric===value?'selected':''} aria-pressed={metric===value} onClick={()=>setMetric(value)}>{label}</button>)}</div>
          <button className="link-button" onClick={()=>setPage('leaderboard','people')}>完整排行榜</button>
        </>}>
          <p className="secondary">按{usageMetricLabels[metric]}降序；Token 排名只统计用量完整的调用，待核对金额不参与排序。额度入口进入现有开通 / 追加流程，仍需在预览里确认名单与金额。</p>
          {top.length?<ol className="cockpit-rank">{top.map((row,index)=>{
            const member=memberOf(row.key);
            return <li key={row.key} className={`cockpit-rank-row ${index<3?'is-top':''}`}>
              <span className="cockpit-rank-no">{String(index+1).padStart(2,'0')}</span>
              <span className="cockpit-rank-name"><b><button className="link-button" data-usage-drill="people" onClick={()=>drill(names.subject(row.key),{subjectId:row.key,subjectType:'employee'})}>{names.subject(row.key)}</button></b><small>{member?names.organization(member.organizationId):'应用 / 未识别'}</small></span>
              <span className="cockpit-rank-track"><ShareBar ratio={metricValue(row,metric)/maxValue} label={metricText(row,metric)}/></span>
              <span className="cockpit-rank-share">{metricTotal?percent(metricValue(row,metric),metricTotal):'—'}</span>
              <span className="cockpit-rank-action">{member?<button className="link-button" aria-label={`调整 ${member.name} 的额度`} onClick={()=>edit.grantPlan(undefined,member.id)}>额度</button>:null}</span>
            </li>;
          })}</ol>:<ChartEmpty>窗口内没有可排名的人员调用。可打开排行榜逐条核对，或放宽筛选。</ChartEmpty>}
          <div className="cockpit-rank-foot">
            {rest.length>0&&<><span>其余 {rest.length} 人</span><b>{metricText(restBucket,metric)}</b></>}
            <span className="cockpit-foot-spacer">合计</span><b>{metric==='cost'?money(totals?.confirmedAmount??0):metric==='tokens'?`${(((totals?.inputTokens??0)+(totals?.outputTokens??0))/1000000).toFixed(2)}M`:(totals?.requests??0).toLocaleString('zh-CN')}</b>
          </div>
        </Panel></div>

        <div className="cockpit-area-gauge"><Panel title="人员活跃度">
          <GaugeChart ratio={entitled.size?activeCount/entitled.size:0} value={String(activeCount)} unit="/ 已开通人员" label="已活跃人员"
            caption={`活跃率 ${percent(activeCount,entitled.size)} · 分母为有效且未到期的已开通人员`}
            boxes={[{label:'本期无调用',value:String(inactiveCount)}]}/>
          <p className="secondary">无调用人员显示为「本期无调用」，不显示为 0 费用，也不参与排名。</p>
        </Panel></div>

        <div className="cockpit-area-org"><Panel title="归属排名" actions={<button className="link-button" onClick={()=>setPage('leaderboard',dimensionPage[dimension])}>完整排行榜</button>}>
          <div className="section-tabs cockpit-seg" aria-label="归属维度" role="tablist">{(['organizations','projects','applications'] as Dimension[]).map(value=><button key={value} type="button" role="tab" aria-selected={dimension===value} className={dimension===value?'selected':''} onClick={()=>setDimension(value)}>{dimensionLabels[value]}</button>)}</div>
          {dimensionRows.slice(0,5).map(row=><div className="cockpit-dim-row" key={row.key||'none'}>
            <span>{row.key?<button className="link-button" data-usage-drill={dimension} onClick={()=>drill(dimensionName(row.key),dimension==='projects'?{projectId:row.key}:dimension==='applications'?{subjectId:row.key,subjectType:'application'}:{organizationId:row.key})}>{dimensionName(row.key)}</button>:dimensionName(row.key)}</span>
            <ShareBar ratio={row.confirmedAmount/dimensionTotal} label={money(row.confirmedAmount)}/>
            <b>{percent(row.confirmedAmount,totals?.confirmedAmount||0)}</b>
            <span className="cockpit-dim-action">{dimension==='projects'&&projectOf(row.key)?<button className="link-button" onClick={()=>edit.fund('project',projectOf(row.key)!)}>额度</button>:dimension==='applications'&&applicationOf(row.key)?<button className="link-button" onClick={()=>applicationOf(row.key)!.billingMode==='accounting'?setPage('applications',applicationOf(row.key)!.id):edit.fund('application',applicationOf(row.key)!)}>{applicationOf(row.key)!.billingMode==='accounting'?'记账':'额度'}</button>:dimension==='organizations'?<button className="link-button" onClick={()=>setPage('members')}>成员</button>:null}</span>
          </div>)}
          {dimensionRows.length===0&&<ChartEmpty>{dimension==='organizations'?'窗口内没有带组织归属的调用。':dimension==='projects'?'窗口内没有带项目归属的调用；个人与独立应用调用不属于任何项目。':'窗口内没有独立应用发起的调用。'}</ChartEmpty>}
          {dimensionRows.length>0&&<p className="secondary">共 {dimensionRows.length} 个{dimensionLabels[dimension]}，合计 {money(dimensionRows.reduce((sum,row)=>sum+row.confirmedAmount,0))}（占已确认费用 {percent(dimensionRows.reduce((sum,row)=>sum+row.confirmedAmount,0),totals?.confirmedAmount||0)}）。</p>}
          {unattributed&&dimension==='organizations'&&<p className="secondary">另有 {unattributed.requests} 次调用没有组织归属，计入合计但不进入组织排名。</p>}
        </Panel></div>

        <div className="cockpit-area-quality">{qualityPanel}</div>

        <div className="cockpit-area-trend"><Panel title="用量趋势" actions={<span className="tag">{trendKeys.length?`${trendKeys[0]} → ${trendKeys.at(-1)}`:'—'}</span>}>
          {trendPoints.length>1
            ?<TrendChart points={trendPoints} primaryLabel="已确认费用" secondaryLabel="请求数" formatPrimary={value=>value>=100?'¥'+value.toFixed(0):'¥'+value.toFixed(2)} formatSecondary={value=>String(Math.round(value))} ariaLabel={`窗口内每日已确认费用与请求数：${trendPoints.length<=10?trendPoints.map(point=>`${point.label} ${money(point.primary)} / ${point.secondary} 次`).join('；'):`共 ${trendPoints.length} 天，从 ${trendPoints[0].label} 到 ${trendPoints.at(-1)?.label}`}`}/>
            :<ChartEmpty>窗口不足两天或没有调用，暂时无法形成趋势。跨天选择时间段后再看。</ChartEmpty>}
          {days.length>0&&<details className="disclosure">
            <summary>逐日数值</summary>
            <Table headers={['日期','请求','输入 / 输出 Token','已确认费用','待核对']} rows={days.map(row=>[row.key,row.requests.toLocaleString('zh-CN'),`${(row.inputTokens/1000000).toFixed(2)}M / ${(row.outputTokens/1000000).toFixed(2)}M`,money(row.confirmedAmount),pendingText(row.pendingReview,row.pendingAmount)])}/>
          </details>}
          <p className="secondary">按工作区时区（{report?.timezone??'Asia/Shanghai'}）切分自然日，没有调用的一天按 0 绘制；今日为进行中数据，不与其他完整日同比。</p>
        </Panel></div>
      </div>
    </>;

  return <div className="usage-cockpit">
    <UsageFilterBar data={data} state={query} names={names}/>
    {report&&<UsageCostReport report={report} names={names}/>}
    {report&&!hasData?emptyPage:cockpit}
    <p className="secondary">窗口内已结束调用；在途、未识别密钥与控制面未收到的请求不在分母内。Token 只计完整用量，费用只计已确认金额；导出 CSV 时待核对的未知金额留空。完整表格在「排行榜」。</p>
  </div>;
}
