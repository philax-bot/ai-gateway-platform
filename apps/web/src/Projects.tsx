import {PersonPicker} from './PersonPicker';
import {memberIdentity,memberLabel} from './person-identity';
import type {PersonSummary} from '@ai-gateway/contracts';
import {hasPermission} from '@ai-gateway/contracts';
import { useEffect,useRef,useState } from 'react';
import type { BusinessQuotaBatch,PlatformSnapshot,Project,ProjectDetail } from '@ai-gateway/contracts';
import { api } from './client';
import { purposeLabels } from './Online';
import { date,Field,money,Panel,Status,Table } from './components';
import { responsible } from './ApprovalCenter';
import type { makeEditors,RunCommand } from './editors';
import type { PageProps } from './WorkspacePages';
type Editors=ReturnType<typeof makeEditors>;
type Detail=PageProps['detail'];
/* 项目共用 active/paused/ended，但 active 在成员和密钥上是“已启用”，这里必须显示“进行中”。 */
const projectStatus:Record<string,string>={active:'进行中',paused:'已暂停',ended:'已结束'};
const statusRank:Record<string,number>={active:0,paused:1,ended:2};
const live=(batch:{closedAt?:string|null;expiresAt:string})=>!batch.closedAt&&Date.parse(batch.expiresAt)>Date.now();
const sum=(values:number[])=>Number(values.reduce((total,value)=>total+value,0).toFixed(6));

export function ProjectMemberPicker({projectId,run}:{projectId:string;run:RunCommand}){
  const [selected,setSelected]=useState<string[]>([]),[people,setPeople]=useState<PersonSummary[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function save(){setBusy(true);setMessage('');try{if(await run('project.members',{projectId,memberIds:selected})!==null){setMessage(`已添加 ${selected.length} 名成员：${people.map(p=>`${p.name}（${p.directoryId}） · ${p.organizationPath}`).join('、')}。尚未发放额度，返回项目后可继续分配。`);setSelected([]);}}catch(e){setMessage(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}}
  return <><p>按组织、姓名或账号选择有效企业成员；已加入当前项目的人员不在候选名单中。确认选择后，还需预览并添加到项目。</p><PersonPicker label="选择项目成员" multiple required source={{scope:'project-members',projectId}} value={selected} initialPeople={people} disabled={busy} onChange={(ids,items)=>{setSelected(ids);setPeople(items);}}/>{message&&<p role="status" className="notice">{message}</p>}<button type="button" className="primary" disabled={busy||!selected.length} onClick={()=>void save()}>{busy?'处理中…':'添加所选成员'}</button></>;
}


type AttentionKind='members'|'expiry';
function attentionLabel(kind:AttentionKind,attention:NonNullable<ProjectDetail['attention']>){
  if(kind==='members')return `${attention.unfundedMemberIds.length} 人待分配`;
  return `${money(sum(attention.expiringBudgets.map(b=>b.amount)))} 将在 7 天内到期`;
}

/* 项目对象页：从弹窗搬到页面内，保留原 Panel / Table / detail 语言，返回列表用页面导航而不是关闭弹窗。 */
export function ProjectDetails({projectId,edit,data,run,onAdd,onBack,initialTask,onUseModel}:{initialTask?:AttentionKind;onUseModel:PageProps['onUseModel'];projectId:string;edit:Editors;data:PlatformSnapshot;run:RunCommand;onAdd:()=>void;onBack:()=>void}){
  const [value,setValue]=useState<ProjectDetail|null>(null),[error,setError]=useState(''),[collectedAt,setCollectedAt]=useState(''),[busy,setBusy]=useState(false);
  async function load(){setBusy(true);try{const next=await api<ProjectDetail>(`/api/v1/platform/projects/${encodeURIComponent(projectId)}`);setValue(next);setCollectedAt(new Date().toISOString());setError('');}catch(e){setError(e instanceof Error?e.message:'读取失败');}finally{setBusy(false);}}
  useEffect(()=>{void load();},[projectId,data]);
  const [task,setTask]=useState(initialTask),[modelId,setModelId]=useState('');
  const taskHeading=useRef<HTMLHeadingElement>(null),loaded=!!value;
  useEffect(()=>{if(loaded&&initialTask)taskHeading.current?.focus();},[loaded,initialTask]);
  const back=<button type="button" className="link-button" onClick={onBack}>← 返回项目列表</button>;
  if(!value)return <>{back}<Panel title="项目"><p role="status">{error||'正在读取项目资金与成员…'}</p>{error&&<button className="ghost" onClick={()=>void load()}>重新读取</button>}</Panel></>;
  const {project:p,members,budgets,consumedByBatch:spent}=value,batches=members.flatMap(m=>m.batches);
  const canFund=hasPermission(data.actor,'finance.write'),canSeeBudget=value.canManage||hasPermission(data.actor,'finance.read');
  const consumed=(rows:BusinessQuotaBatch[])=>sum(rows.map(b=>spent[b.id]??0)),pending=(rows:BusinessQuotaBatch[])=>sum(rows.map(b=>Math.max(0,Number((b.totalAmount-b.availableAmount-(b.closedAmount??0)-(b.returnedAmount??0)-(spent[b.id]??0)).toFixed(6)))));
  const attention=value.attention,expiring=attention?.expiringBudgets??[],unfunded=attention?.unfundedMemberIds??[];
  const selectedTask=task??(unfunded.length?'members':'expiry');
  const remaining=sum(budgets.filter(live).map(b=>b.availableAmount));
  const currentMembers=members.filter(m=>m.isMember&&m.active);
  const purpose=data.purposes.find(item=>item.projectId===p.id);
  const readyModels=purpose?.models.filter(model=>model.status==='ready')??[];
  const selectedModel=readyModels.find(model=>model.modelId===modelId)??readyModels[0];
  const fund=()=>canFund?edit.fund('project',p):edit.request('project_budget',p.id);
  return <>{back}
    <Panel title={p.name} eyebrow="项目" actions={<><Status value={p.status} label={projectStatus[p.status]}/>{canFund&&p.status==='active'&&!value.canManage&&<button className="ghost" onClick={()=>edit.fund('project',p)}>补充项目总额度</button>}<button className="ghost" disabled={busy} onClick={()=>void load()}>{busy?'正在刷新…':'刷新详情'}</button></>}>
      <p className="secondary">经理：{memberIdentity(data,p.managerId)} · {value.canManage?'你可以管理成员与额度':hasPermission(data.actor,'finance.read')?'按运营职责查看':p.memberIds.includes(data.actor.id)?'你是项目成员':'你以申请人身份查看'} · 成员 {p.memberIds.length} 人</p>{error&&<p className="notice danger">{error}</p>}
      {p.description&&<p>{p.description}</p>}
      {(!purpose||canSeeBudget||p.status!=='active')&&<p className="secondary">可用模型：{value.models.map(m=>m.name).join('、')||'当前没有可用模型'}。</p>}
      {(!purpose||canSeeBudget||p.status!=='active')&&<div className="project-summary">{(p.status==='ended'?[['已确认消费',consumed(batches)],['结束已回收',sum([...budgets,...batches].map(b=>b.closedAmount??0))]]:canSeeBudget?[['可分配给成员',sum(budgets.filter(b=>Date.parse(b.expiresAt)>Date.now()).map(b=>b.availableAmount))],['成员剩余额度',sum(batches.filter(b=>Date.parse(b.expiresAt)>Date.now()).map(b=>b.availableAmount))]]:[['我的剩余额度',sum(batches.filter(b=>Date.parse(b.expiresAt)>Date.now()).map(b=>b.availableAmount))],['已确认消费',consumed(batches)]]).map(([label,amount])=><div key={String(label)}>{label}<strong>{money(Number(amount))}</strong></div>)}</div>}
      {attention&&<section className="next-step">
        <h3 ref={taskHeading} tabIndex={-1}>项目额度待办</h3>
        {(unfunded.length>0||expiring.length>0||task)&&<>
          <div className="section-tabs" role="group" aria-label="额度待办类型">
            <button className={selectedTask==='members'?'selected':''} aria-pressed={selectedTask==='members'} onClick={()=>setTask('members')}>{attentionLabel('members',attention)}</button>
            <button className={selectedTask==='expiry'?'selected':''} aria-pressed={selectedTask==='expiry'} onClick={()=>setTask('expiry')}>临期预算 · {expiring.length} 批</button>
          </div>
          {selectedTask==='members'?<Table headers={['待分配成员','操作']} rows={unfunded.map(id=>[memberIdentity(data,id),remaining>0?<button onClick={()=>edit.allocate(p,id)}>分配额度</button>:'待补充项目预算'])} empty="所有有效成员均已有余额。"/>:
            <><p className="secondary">按来源批次汇总未分配预算和已分给成员的有效余额。延期同步到该来源的有效成员批次。</p>
            <Table headers={['来源批次','即将到期的余额','到期时间','操作']} rows={expiring.map(b=>[b.id,money(b.amount),date(b.expiresAt),<button onClick={()=>edit.quotaChange('project',p,b.id,'extend')}>{canFund?'延长有效期':'申请延期'}</button>])} empty="未来 7 天没有带余额的到期预算。"/></>}
        </>}
        {!currentMembers.length?<button className="primary" onClick={onAdd}>添加项目成员</button>:remaining<=0?<button className="primary" onClick={fund}>{canFund?'补充项目总额度':'申请项目总额度'}</button>:<button className="ghost" onClick={()=>edit.allocate(p)}>分配项目额度</button>}
        {currentMembers.length>0&&<button className="link-button" onClick={onAdd}>添加其他成员</button>}
      </section>}
      {purpose&&p.status==='active'&&<section className="next-step"><h3>使用我的项目额度</h3>
        <p>我的可用余额 <strong>{money(purpose.availableAmount)}</strong></p>
        {selectedModel?<>{readyModels.length>1?<Field spec={{key:'project-model',label:'本次使用的模型',type:'select',options:readyModels.map(m=>({value:m.modelId,label:m.name}))}} value={selectedModel.modelId} onChange={v=>setModelId(String(v))}/>:<p>可用模型 · {selectedModel.name}</p>}
          <button className="primary" onClick={()=>onUseModel(purpose.id,selectedModel.modelId)}>用项目额度发起调用</button></>:
          <><p className="notice warning">{purposeLabels[purpose.status]}</p>{['no_quota','quota_insufficient'].includes(purpose.status)&&<button className="ghost" onClick={()=>edit.request('project_member_quota',p.id)}>申请成员额度</button>}</>}
      </section>}
      {p.closedAt&&<p className="notice">结束时间 {date(p.closedAt)} · {p.closeReason}。在途请求仍按原来源结算；后续释放金额进入结束回收记录。</p>}
      <h3>{value.canManage?'项目成员':'我的项目额度'}</h3>{members.map(m=><details className="member-task" key={m.id}><summary><span>{memberIdentity(data,m.id)} <small>{!m.active?'已停用或到期':!m.isMember?'已移出项目':p.status==='ended'?'项目已结束':'项目成员'}</small></span><span>剩余 {money(sum(m.batches.filter(b=>Date.parse(b.expiresAt)>Date.now()).map(b=>b.availableAmount)))}</span></summary><div className="project-summary"><div>已确认消费<strong>{money(consumed(m.batches))}</strong></div><div>预占 / 待核对<strong>{money(pending(m.batches))}</strong></div></div>{value.canManage&&p.status==='active'&&m.active&&m.isMember&&<div className="actions"><button className="ghost" onClick={()=>edit.allocate(p,m.id)}>给 {m.name} 分配额度</button>{m.id!==p.managerId&&<button className="link-button" onClick={()=>{void run('project.members',{projectId:p.id,removeMemberIds:[m.id],memberIds:[]}).then(result=>{if(result!==null)void load();}).catch(e=>setError(e.message));}}>移出项目</button>}</div>}</details>)}
      {!members.length&&<p className="empty">还没有成员。添加成员后可以分配项目额度。</p>}
      <details className="disclosure"><summary>资金来源、消费与回收明细</summary><p className="secondary">读取于 {date(collectedAt)}。项目累计发放只统计总预算。以下为账面余额；能否调用还取决于项目、成员、模型和限制。预占不计入已确认消费。</p><dl className="detail-list"><div><dt>{canSeeBudget?'项目累计发放':'我的累计分配'}</dt><dd>{money(canSeeBudget?sum(budgets.map(b=>b.totalAmount)):sum(batches.map(b=>b.totalAmount)))}</dd></div><div><dt>已过期余额</dt><dd>{money(sum([...budgets,...batches].filter(b=>Date.parse(b.expiresAt)<=Date.now()).map(b=>b.availableAmount)))}</dd></div><div><dt>预占 / 待核对</dt><dd>{money(pending(batches))}</dd></div><div><dt>已回收预算</dt><dd>{money(sum([...budgets,...(p.status==='ended'?batches:[])].map(b=>b.closedAmount??0)))}</dd></div><div><dt>成员待退回</dt><dd>{money(p.status==='ended'?0:sum(batches.map(b=>b.closedAmount??0)))}</dd></div></dl>
      {canSeeBudget&&<><h3>项目来源预算</h3><Table headers={['来源批次','累计发放','待分配余额','已回收','有效期','操作']} rows={budgets.map(b=>[b.id,money(b.totalAmount),money(b.availableAmount),money(b.closedAmount??0),date(b.expiresAt),p.status!=='ended'&&live(b)?<div className="inline-actions">{canFund&&b.availableAmount>0&&<button className="danger-button" onClick={()=>edit.quotaChange('project',p,b.id,'reclaim')}>回收预算</button>}{(canFund||value.canManage)&&!b.expiresAt.startsWith('9999')&&<button onClick={()=>edit.quotaChange('project',p,b.id,'extend')}>{canFund?'延长有效期':'申请延期'}</button>}</div>:'—'])} empty="还没有项目预算。补充总额度后才能分配给成员。"/></>}
      <h3>成员来源批次</h3><Table headers={['成员','原始项目批次','累计分配','账面余额','已退回 / 待退回','有效期','状态 / 操作']} rows={members.flatMap(m=>m.batches.map(b=>[m.name,b.sourceBatchId??'—',money(b.totalAmount),money(b.availableAmount),`${money(b.returnedAmount??0)} / ${money(b.closedAt&&p.status!=='ended'?b.closedAmount??0:0)}`,date(b.expiresAt),<>{b.closedAt?p.status==='ended'?'结束已回收':'已关闭，余额待退回':Date.parse(b.expiresAt)<=Date.now()?'已过期':'保留原期限'}{value.canManage&&p.status!=='ended'&&b.sourceBatchId&&(b.closedAt?b.closedAmount??0:b.availableAmount)>0&&<button className="link-button" onClick={()=>edit.quotaChange('project',p,b.id,'return')}>退回原预算</button>}</>]))} empty="还没有成员额度批次。分配后在这里查看原期限与回收记录。"/><p className="secondary">移出成员会关闭原额度并停用项目密钥；余额及在途请求后续释放金额保留为待退回，可退回原预算。重新加入需重新分配。</p>
      </details>
      {value.canManage&&<details className="disclosure"><summary>项目设置与管理记录</summary>{p.status!=='ended'&&<div className="actions">{data.actor.roles.includes('operator')&&<><button className="ghost" onClick={()=>edit.project(p)}>修改项目与模型范围</button><button className="ghost" onClick={()=>edit.fund('project',p)}>补充项目总额度</button></>}<button className="ghost" onClick={()=>edit.endProject(p)}>结束项目</button></div>}<h3>管理记录</h3><Table headers={['时间','操作人','动作','说明']} rows={value.history.map(h=>[date(h.createdAt),data.members.find(m=>m.id===h.actorId)?.name??h.actorId,({'project.reclaim':'回收项目预算','project.return':'退回成员额度','project.extend':'延长项目额度','project.initial_grant':'项目初始授额','project.changed':'项目配置变更','project.closed':'项目结束回收','project.end':'结束已记录','project.fund':'项目总额度发放','project.allocate':'成员原批次分配','project.members':'成员关系变更','save.project':'项目配置更新'} as Record<string,string>)[h.action]??h.action,h.reason||'—'])} empty="还没有项目管理记录。成员、额度与状态变更会记录在这里。"/></details>}
    </Panel></>;
}

/* 列表页：统计条 + 即时筛选 + 表格。行内只放可比较字段，入口统一为“进入项目”。 */
function ProjectList({data:d,isOps,edit,setPage,staleId,onTask}:{onTask:(id:string,kind:AttentionKind)=>void;data:PlatformSnapshot;isOps:boolean;edit:Editors;setPage:PageProps['setPage'];staleId:string|null}){
  const admin=d.actor.roles.includes('operator'),canFund=hasPermission(d.actor,'finance.write'),canReadFunds=hasPermission(d.actor,'finance.read'),[query,setQuery]=useState(''),[status,setStatus]=useState(''),[scope,setScope]=useState('');
  const name=(id:string)=>memberLabel(d,id);
  const canManage=(p:Project)=>admin||p.managerId===d.actor.id;
  const counts={active:0,paused:0,ended:0};for(const p of d.projects)counts[p.status]+=1;
  const pending=d.approvals.filter(a=>a.kind.startsWith('project')&&['pending','approved','failed'].includes(a.status)&&responsible(d,a)).length;
  const activeCount=[query,status,scope].filter(Boolean).length;
  const rows=d.projects.filter(p=>{
    if(status&&p.status!==status)return false;
    if(scope==='managed'&&p.managerId!==d.actor.id)return false;
    if(scope==='joined'&&!p.memberIds.includes(d.actor.id))return false;
    return !query.trim()||`${p.name} ${p.description??''} ${name(p.managerId)}`.toLowerCase().includes(query.trim().toLowerCase());
  }).slice().sort((a,b)=>(statusRank[a.status]??3)-(statusRank[b.status]??3)||a.name.localeCompare(b.name,'zh-CN'));
  const clear=()=>{setQuery('');setStatus('');setScope('');};
  /* 额度口径按角色取：运营看项目可分配 + 全部成员批次；经理只有项目预算；成员只有自己的批次。 */
  function funds(p:Project){
    const budgets=d.projectBudgets.filter(b=>b.projectId===p.id&&live(b));
    if(admin||canReadFunds)return {main:money(sum(budgets.map(b=>b.availableAmount))),help:`成员剩余 ${money(sum(d.quotaBatches.filter(b=>b.projectId===p.id&&b.purpose==='project'&&live(b)).map(b=>b.availableAmount)))}`};
    if(p.managerId===d.actor.id)return {main:money(sum(budgets.map(b=>b.availableAmount))),help:'待分配给成员'};
    if(p.memberIds.includes(d.actor.id))return {main:money(sum(d.quotaBatches.filter(b=>b.projectId===p.id&&b.purpose==='project'&&live(b)).map(b=>b.availableAmount))),help:'我的项目额度'};
    return {main:'—',help:'未加入成员'};
  }
  const emptyState=d.projects.length?<div className="empty-state"><strong>没有符合当前条件的项目</strong><p>已设置 {activeCount} 项筛选条件。可以清除筛选，或换一个状态与范围再查。</p><div className="actions"><button className="ghost" onClick={clear}>清除筛选</button></div></div>:<div className="empty-state"><strong>还没有项目</strong><p>{isOps?'项目为一组成员承载共同额度。创建时填写初始预算，添加成员后再按成员分配。':'你还没有参与任何项目。个人日常办公与编程无需先建项目；需要部门共享额度时，由运营创建项目并把你加入。'}</p></div>;
  return <>
    {staleId&&<p className="notice warning">该项目已不在你的权限范围内，已返回项目列表。</p>}
    <Panel title={isOps?'项目运营':'我的项目'} actions={isOps&&admin?<button className="primary" onClick={()=>edit.project()}>创建项目</button>:!isOps?<button className="primary" onClick={()=>edit.request('project_create')}>申请创建项目</button>:null}>
      <p className="secondary">项目额度按来源批次发给成员，结束项目会回收未使用余额。下表额度为账面合计；能否调用还取决于模型、成员与限制。</p>
      <div className="metric-grid">{[['进行中',counts.active,'','可以分配与调用'],['已暂停',counts.paused,counts.paused?'is-alert':'','暂停期间不接受新调用'],['已结束',counts.ended,'','终态，仅可查看记录'],['待我处理',pending,pending?'is-alert':'','项目相关申请']].map(([label,value,tone,hint])=><article className={`metric ${tone}`} key={String(label)}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>)}</div>
      <form className="call-filters call-filter-form" onSubmit={event=>event.preventDefault()}>
        <div className="filter-primary">
          <label>搜索名称 / 说明 / 经理<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="例如：增长实验、张三"/></label>
          <label>状态<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">全部状态</option>{Object.entries(projectStatus).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          <label>我的角色<select value={scope} onChange={e=>setScope(e.target.value)}><option value="">全部项目</option><option value="managed">我负责的</option><option value="joined">我参与的</option></select></label>
        </div>
        <div className="filter-actions">
          <span className="filter-state" role="status">即时筛选 · 显示 {rows.length} / {d.projects.length} 个项目{activeCount?` · 已设置 ${activeCount} 项条件`:''}</span>
          <button type="button" className="ghost" disabled={!activeCount} onClick={clear}>清除筛选</button>
        </div>
      </form>
      <Table headers={['项目','状态','经理','成员','额度','操作']} empty={emptyState} rows={rows.map(p=>{
        const manage=canManage(p),member=p.memberIds.includes(d.actor.id),amount=funds(p);
        const attention=p.attention,kind=attention?.unfundedMemberIds.length?'members':attention?.expiringBudgets.length?'expiry':null;
        return [
          <>{p.name}<small className="cell-help">{p.description||'无说明'}</small></>,
          <><Status value={p.status} label={projectStatus[p.status]}/>{kind&&attention&&<small className="cell-help"><button className="link-button" onClick={()=>onTask(p.id,kind)}><Status value="pending" label={attentionLabel(kind,attention)}/></button></small>}{p.status==='ended'&&p.closedAt&&<small className="cell-help">{date(p.closedAt)} 结束</small>}</>,
          <>{name(p.managerId)}{p.managerId===d.actor.id&&<small className="cell-help">我负责</small>}</>,
          `${p.memberIds.length} 人`,
          <>{amount.main}<small className="cell-help">{amount.help}</small></>,
          <div className="inline-actions"><button onClick={()=>setPage('projects',p.id)}>{p.status==='ended'?'查看结束记录':manage?'管理项目':canReadFunds?'查看项目详情':'查看我的额度'}</button>{p.status==='active'&&canFund&&<button onClick={()=>edit.fund('project',p)}>补充额度</button>}{p.status==='active'&&manage&&!canFund&&<button onClick={()=>edit.request('project_budget',p.id)}>申请额度</button>}{p.status==='active'&&!manage&&member&&<button onClick={()=>edit.request('project_member_quota',p.id)}>申请额度</button>}</div>,
        ];
      })}/>
    </Panel>
  </>;
}

export function Projects({data:d,isOps,edit,run,detail,setPage,targetId,onUseModel}:{onUseModel:PageProps['onUseModel'];data:PlatformSnapshot;isOps:boolean;edit:Editors;run:RunCommand;detail:Detail;setPage:PageProps['setPage'];targetId?:string|null}){
  const [focus,setFocus]=useState<{id:string;kind:AttentionKind}|null>(null);
  useEffect(()=>{if(focus&&focus.id!==targetId)setFocus(null);},[targetId,focus]);
  const project=targetId?d.projects.find(p=>p.id===targetId):undefined;
  if(project)return <ProjectDetails key={project.id} onUseModel={onUseModel} initialTask={focus?.id===project.id?focus.kind:undefined} projectId={project.id} edit={edit} data={d} run={run} onBack={()=>setPage('projects')} onAdd={()=>detail('添加项目成员',<ProjectMemberPicker projectId={project.id} run={run}/>)}/>;
  return <ProjectList onTask={(id,kind)=>{setFocus({id,kind});setPage('projects',id);}} data={d} isOps={isOps} edit={edit} setPage={setPage} staleId={targetId??null}/>;
}
