import { useMemo, useState } from 'react';
import type { PlatformSnapshot, UsageBucket } from '@ai-gateway/contracts';
import { date, money as formatMoney } from './components';
import { ChartEmpty, DonutChart, GaugeChart, TrendChart } from './components-charts';
import { calendarDays, emptyBucket, metricValue, percent, pendingText, usageMetricLabels, usageMetricSwitch, usageNames, usagePeople, useUsageQuery, type UsageMetric } from './usage-shared';

/*
 * 三版驾驶舱并列演示。同一个窗口、同一份聚合数据、同一套图表组件，
 * 只换皮肤与信息密度：浅色列表版 / 深蓝科技版 / 信标大屏版。
 * 目的不是产品页面，而是把三个视觉方向放进真实壳层里左右对照。
 */

export type CockpitVariant='light'|'tech'|'beacon';
type Props={data:PlatformSnapshot;active?:boolean;setPage:(page:string,id?:string)=>void};

const variants:Record<CockpitVariant,{page:string;label:string}>={
  light:{page:'cockpit-light',label:'浅色列表版'},
  tech:{page:'cockpit-tech',label:'深蓝科技版'},
  beacon:{page:'cockpit-beacon',label:'信标大屏版'},
};

const presets:[string,number|null][]=[['本月至今',null],['近 7 天',7],['近 30 天',30]];

function DemoSwitch({variant,setPage}:{variant:CockpitVariant;setPage:Props['setPage']}){
  return <div className="dc-switch" role="group" aria-label="三版驾驶舱并列演示">
    {(Object.keys(variants) as CockpitVariant[]).map(value=><button key={value} type="button" className={variant===value?'is-active':''} aria-pressed={variant===value} onClick={()=>setPage(variants[value].page)}>{variants[value].label}</button>)}
  </div>;
}

export function CockpitDemo({variant,data,active=true,setPage}:Props&{variant:CockpitVariant}){
  const query=useUsageQuery(active),names=usageNames(data);
  const [metric,setMetric]=useState<UsageMetric>('cost'),[preset,setPreset]=useState<string>('本月至今');
  const report=query.report,totals=report?.totals;
  const {people,unknownSubjects,entitled,activeCount,inactiveCount}=usagePeople(data,report?.people??[]);
  const ranked=useMemo(()=>[...people].sort((a,b)=>metricValue(b,metric)-metricValue(a,metric)),[people,metric]);
  const top=ranked.slice(0,8),maxValue=Math.max(1,...top.map(row=>metricValue(row,metric)));
  const metricTotal=metric==='cost'?(totals?.confirmedAmount??0):metric==='tokens'?((totals?.inputTokens??0)+(totals?.outputTokens??0)):totals?.requests??0;
  const rest=ranked.slice(8);
  const restValue=rest.reduce<UsageBucket>((sum,row)=>({...sum,requests:sum.requests+row.requests,inputTokens:sum.inputTokens+row.inputTokens,outputTokens:sum.outputTokens+row.outputTokens,confirmedAmount:sum.confirmedAmount+row.confirmedAmount}),{...emptyBucket});
  const models=report?.models??[];
  const modelSegments=models.slice(0,3).map(row=>({label:names.model(row.key),value:percent(row.confirmedAmount,totals?.confirmedAmount||0),ratio:totals?.confirmedAmount?row.confirmedAmount/totals.confirmedAmount:0,detail:formatMoney(row.confirmedAmount)}));
  const otherModels=models.slice(3);
  if(otherModels.length){
    const amount=otherModels.reduce((sum,row)=>sum+row.confirmedAmount,0);
    modelSegments.push({label:`其他 ${otherModels.length} 个模型`,value:percent(amount,totals?.confirmedAmount||0),ratio:totals?.confirmedAmount?amount/totals.confirmedAmount:0,detail:formatMoney(amount)});
  }
  const organizations=(report?.organizations??[]).filter(row=>row.key).slice(0,4);
  const orgTotal=Math.max(1,...organizations.map(row=>row.confirmedAmount));
  const dayRows=new Map((report?.days??[]).map(row=>[row.key,row]));
  const trendKeys=report?calendarDays(report.from,report.to,report.timezone):[];
  const days=trendKeys.map(key=>dayRows.get(key)??{...emptyBucket,key});
  const trendPoints=days.map(row=>({label:row.key,primary:row.confirmedAmount,secondary:row.requests}));
  const hasData=!!report&&(totals?.requests??0)>0;

  const range=(label:string,days:number|null)=>{setPreset(label);query.range(days);};

  const hero=<section className="dc-hero" aria-label="窗口汇总">
    <div className="dc-hero-main">
      <span className="dc-hero-label">已确认费用 · {preset}</span>
      <span className="dc-hero-value">{totals?formatMoney(totals.confirmedAmount):'未知'}</span>
      <span className="dc-hero-note">{report?`${trendKeys[0]??''} 至 ${trendKeys.at(-1)??''} · 按 ${report.timezone} 切分自然日 · 待核对 ${totals?.pendingReview??0} 条单独列出`:query.error?'当前窗口数字不可用':'正在读取窗口…'}</span>
    </div>
    <div className="dc-hero-side">
      <div><span>活跃人员</span><b>{totals?`${activeCount} / ${entitled.size}`:'未知'}</b></div>
      <div><span>已结束请求</span><b>{totals?totals.requests.toLocaleString('zh-CN'):'未知'}</b></div>
      <div><span>异常</span><b>{totals?`${totals.errors} 次`:'未知'}</b></div>
    </div>
  </section>;

  const kpis=<div className="dc-kpis">
    <article className="dc-kpi"><span>活跃人员</span><b>{report?activeCount:'未知'}</b><small>当前有效开通人员中有调用的人数</small></article>
    <article className="dc-kpi"><span>已结束请求</span><b>{totals?totals.requests.toLocaleString('zh-CN'):'未知'}</b><small>人均 {totals&&totals.activePeople?Math.round(totals.requests/totals.activePeople):'—'} 次</small></article>
    <article className="dc-kpi"><span>输入 / 输出 Token</span><b>{totals?`${(totals.inputTokens/1000000).toFixed(2)}M / ${(totals.outputTokens/1000000).toFixed(2)}M`:'未知'}</b><small>未知用量 {totals?.unknownUsage??0} 条未计入</small></article>
    <article className={`dc-kpi ${(totals?.pendingReview??0)>0?'is-alert':''}`}><span>待核对费用</span><b>{!totals?'未知':totals.pendingReview===0?formatMoney(0):totals.pendingAmount>0?formatMoney(totals.pendingAmount):'金额待定'}</b><small>{totals?.pendingReview??0} 条 · 不代表免费</small></article>
  </div>;

  const rankPanel=<section className="dc-panel">
    <header><h3>用户排名</h3><span className="tag">{usageMetricLabels[metric]}</span></header>
    {top.length?<ol className="dc-rank">{top.map((row,index)=><li key={row.key} className={`dc-rank-row ${index<3?'is-top':''}`}>
      <span className="dc-rank-no">{String(index+1).padStart(2,'0')}</span>
      <span className="dc-rank-name"><b>{names.subject(row.key)}</b><small>{names.member(row.key)?names.organization(data.members.find(member=>member.id===row.key)?.organizationId??''):'应用 / 未识别'}</small></span>
      <span className="dc-track" aria-hidden="true"><i style={{width:`${Math.max(1,metricValue(row,metric)/maxValue*100).toFixed(1)}%`}}/></span>
      <span className="dc-rank-val">{metric==='cost'?formatMoney(row.confirmedAmount):metric==='tokens'?`${((row.inputTokens+row.outputTokens)/1000000).toFixed(2)}M`:`${row.requests} 次`}</span>
      <span className="dc-rank-share">{metricTotal?percent(metricValue(row,metric),metricTotal):'—'}</span>
    </li>)}</ol>:<ChartEmpty>窗口内没有可排名的人员调用。</ChartEmpty>}
    <div className="dc-foot">
      {rest.length>0&&<><span>其余 {rest.length} 人</span><b>{metric==='cost'?formatMoney(restValue.confirmedAmount):metric==='tokens'?`${((restValue.inputTokens+restValue.outputTokens)/1000000).toFixed(2)}M`:`${restValue.requests} 次`}</b></>}
      <span className="dc-spacer">合计</span><b>{metric==='cost'?formatMoney(totals?.confirmedAmount??0):metric==='tokens'?`${(((totals?.inputTokens??0)+(totals?.outputTokens??0))/1000000).toFixed(2)}M`:(totals?.requests??0).toLocaleString('zh-CN')}</b>
    </div>
  </section>;

  const modelPanel=<section className="dc-panel">
    <header><h3>模型用量分布</h3><span className="tag">{models.length} 个模型</span></header>
    {hasData&&modelSegments.length
      ?<DonutChart center={formatMoney(totals?.confirmedAmount??0)} centerLabel="已确认费用" label={`模型费用占比：${modelSegments.map(segment=>`${segment.label} ${segment.value}`).join('，')}`} segments={modelSegments}/>
      :<ChartEmpty>窗口内没有可比较的模型费用。</ChartEmpty>}
  </section>;

  const orgPanel=<section className="dc-panel">
    <header><h3>组织用量</h3><span className="tag">{organizations.length} 个组织</span></header>
    {organizations.length?<div className="dc-split">{organizations.map(row=><div className="dc-split-row" key={row.key}>
      <span>{names.organization(row.key)}</span>
      <span className="dc-track" aria-hidden="true"><i style={{width:`${Math.max(1,row.confirmedAmount/orgTotal*100).toFixed(1)}%`}}/></span>
      <b>{percent(row.confirmedAmount,totals?.confirmedAmount||0)}</b>
    </div>)}</div>:<ChartEmpty>窗口内没有带组织归属的调用。</ChartEmpty>}
    <p className="dc-note">无组织归属的调用计入合计，不进组织排名。</p>
  </section>;

  const gaugePanel=<section className="dc-panel">
    <header><h3>人员活跃度</h3><span className="tag">活跃率 {percent(activeCount,entitled.size)}</span></header>
    <GaugeChart ratio={entitled.size?activeCount/entitled.size:0} value={String(activeCount)} unit="/ 已开通人员" label="已活跃人员" caption="分母为有效且未到期的已开通人员" boxes={[{label:'本期无调用',value:String(inactiveCount)}]}/>
  </section>;

  const trendPanel=<section className="dc-panel">
    <header><h3>用量趋势</h3><span className="tag">{trendKeys.length?`${trendKeys[0]} → ${trendKeys.at(-1)}`:'—'}</span></header>
    {trendPoints.length>1
      ?<TrendChart points={trendPoints} primaryLabel="已确认费用" secondaryLabel="请求数" formatPrimary={value=>value>=100?'¥'+value.toFixed(0):'¥'+value.toFixed(2)} formatSecondary={value=>String(Math.round(value))} ariaLabel={`每日已确认费用与请求数：${trendPoints.length<=10?trendPoints.map(point=>`${point.label} ${formatMoney(point.primary)} / ${point.secondary} 次`).join('；'):`共 ${trendPoints.length} 天`}`}/>
      :<ChartEmpty>窗口不足两天，暂时无法形成趋势。</ChartEmpty>}
    <p className="dc-note">没有调用的一天按 0 绘制；今日为进行中数据。</p>
  </section>;

  const qualityPanel=<section className="dc-panel">
    <header><h3>数据质量</h3>{query.error?<span className="tag">读取失败</span>:<span className="tag">已采集</span>}</header>
    <dl className="dc-quality">
      <div><dt>最近读取</dt><dd>{report?date(report.collectedAt):'—'}</dd></div>
      <div><dt>用量未知</dt><dd>{totals?`${totals.unknownUsage} 条`:'—'}</dd></div>
      <div><dt>待核对</dt><dd>{totals?pendingText(totals.pendingReview,totals.pendingAmount):'—'}</dd></div>
      <div><dt>未识别身份</dt><dd>{report?`${unknownSubjects.length} 个主体`:'—'}</dd></div>
      <div><dt>本期无调用</dt><dd>{report?`${inactiveCount} 人`:'—'}</dd></div>
      <div><dt>上游故障</dt><dd>{totals?`${totals.upstreamFailures} 次`:'—'}</dd></div>
    </dl>
    <p className="dc-note">Token 只计完整用量；费用只计已确认金额；未知用量与待核对费用单列。</p>
  </section>;

  return <div className={`demo-cockpit is-${variant}`}>
    <header className="dc-head">
      <p className="dc-head-note">同一窗口 · 同一份聚合数据 · 三版并列；切换只改视觉与信息密度。</p>
      <div className="dc-head-tools">
        <DemoSwitch variant={variant} setPage={setPage}/>
        <div className="dc-controls">
          <div className="dc-seg" role="group" aria-label="时间窗口">{presets.map(([label,days])=><button key={label} type="button" className={preset===label?'is-active':''} aria-pressed={preset===label} onClick={()=>range(label,days)}>{label}</button>)}</div>
          <div className="dc-seg" role="group" aria-label="排名口径">{usageMetricSwitch.map(([value,label])=><button key={value} type="button" className={metric===value?'is-active':''} aria-pressed={metric===value} onClick={()=>setMetric(value)}>{label}</button>)}</div>
        </div>
      </div>
    </header>

    {hero}
    {query.error&&<div className="notice danger" role="alert">{`${query.error} 当前数字不可用。`}</div>}
    {!report
      ?<section className="dc-panel"><header><h3>{query.error?'用量汇总暂不可用':'正在读取用量汇总'}</h3></header><p className="dc-note">{query.error?'请重新选择时间窗口重试，或检查监控采集。':'首次打开需要读取窗口内的已结束调用。'}</p></section>
      :!hasData
        ?<section className="dc-panel"><header><h3>这段时间没有调用</h3></header>
          <p className="dc-note">窗口内没有已结束调用。换一个时间窗口再看；在途调用与采集失败不计入这里。</p>
          <div><button className="ghost" onClick={()=>range('本月至今',null)}>回到本月至今</button></div>
        </section>
        :<>
          {kpis}
          {variant==='light'
            ?<div className="dc-grid is-light">
              <div className="dc-col">{rankPanel}{trendPanel}</div>
              <div className="dc-col">{modelPanel}{orgPanel}{qualityPanel}</div>
            </div>
            :<div className={`dc-grid is-${variant}`}>
              <div className="dc-span-2">{modelPanel}</div>
              <div className="dc-span-4">{rankPanel}</div>
              <div className="dc-span-2">{gaugePanel}</div>
              <div className="dc-span-2">{orgPanel}</div>
              <div className="dc-span-2">{qualityPanel}</div>
              <div className="dc-span-6">{trendPanel}</div>
            </div>}
        </>}
    <p className="dc-note">演示页面 · 数据来自 <code>POST /api/v1/platform/analytics/usage</code> · 与「用量驾驶舱」「排行榜」同一口径 · 不含编辑动作</p>
  </div>;
}

export function CockpitLightDemo(props:Props){return <CockpitDemo {...props} variant="light"/>;}
export function CockpitTechDemo(props:Props){return <CockpitDemo {...props} variant="tech"/>;}
export function CockpitBeaconDemo(props:Props){return <CockpitDemo {...props} variant="beacon"/>;}
