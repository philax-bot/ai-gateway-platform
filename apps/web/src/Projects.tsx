import { useEffect,useState } from 'react';
import type { BusinessQuotaBatch,PlatformSnapshot,Project,ProjectDetail } from '@ai-gateway/contracts';
import { api } from './client';
import { date,money,Panel,Status,Table } from './components';
import { responsible } from './ApprovalCenter';
import type { makeEditors,RunCommand } from './editors';
import type { PageProps } from './WorkspacePages';
type Editors=ReturnType<typeof makeEditors>;
type Detail=PageProps['detail'];
type Candidate={id:string;name:string;organizationName:string};
/* 项目共用 active/paused/ended，但 active 在成员和密钥上是“已启用”，这里必须显示“进行中”。 */
const projectStatus:Record<string,string>={active:'进行中',paused:'已暂停',ended:'已结束'};
const statusRank:Record<string,number>={active:0,paused:1,ended:2};
const live=(batch:{closedAt?:string|null;expiresAt:string})=>!batch.closedAt&&Date.parse(batch.expiresAt)>Date.now();
const sum=(values:number[])=>Number(values.reduce((total,value)=>total+value,0).toFixed(6));

export function ProjectMemberPicker({projectId,run}:{projectId:string;run:RunCommand}){
  const [rows,setRows]=useState<Candidate[]|null>(null),[selected,setSelected]=useState<string[]>([]),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function load(){const rows=await api<Candidate[]>(`/api/v1/platform/projects/${encodeURIComponent(projectId)}/member-candidates`);setRows(rows);}
  useEffect(()=>{void load().catch(e=>setMessage(e.message));},[projectId]);
  async function save(){setBusy(true);setMessage('');try{if(await run('project.members',{projectId,memberIds:selected})!==null){setMessage(`已添加 ${selected.length} 名成员；尚未发放额度。关闭本窗口后回到项目，继续分配给成员。`);setSelected([]);await load();}}catch(e){setMessage(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}}
  const filtered=(rows??[]).filter(m=>!query.trim()||`${m.name} ${m.organizationName}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <><p>从有效企业成员中选择；已加入、停用、到期或组织无效的人员不在候选名单中。添加成员不会产生额度。</p>
    <label className="person-search">按姓名或组织筛选<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="例如：张三、研发部"/></label>
    <fieldset className="choice-list choice-list-people"><legend className="sr-only">选择成员</legend>
      <div className="choice-list-head"><strong>选择成员</strong><span className="choice-count">已选 {selected.length} 人 · 显示 {filtered.length} 人</span><div className="choice-tools"><button type="button" className="link-button" disabled={!filtered.length} onClick={()=>setSelected(previous=>[...new Set([...previous,...filtered.map(m=>m.id)])])}>全选当前结果</button>{selected.length>0&&<button type="button" className="link-button" onClick={()=>setSelected([])}>清空</button>}</div></div>
      <div className="person-list">{filtered.map(m=><label key={m.id} className={`person-row ${selected.includes(m.id)?'selected':''}`}><input type="checkbox" aria-label={`选择 ${m.name}`} checked={selected.includes(m.id)} onChange={e=>setSelected(previous=>e.target.checked?[...previous,m.id]:previous.filter(id=>id!==m.id))}/><span className="person-copy"><strong>{m.name}</strong><small>{m.organizationName}</small></span></label>)}{!filtered.length&&<p className="person-empty">{rows===null?'正在读取…':'没有可添加的有效成员'}</p>}</div>
    </fieldset>
    {message&&<p role="status" className="notice">{message}</p>}<button className="primary" disabled={busy||!selected.length} onClick={()=>void save()}>{busy?'处理中…':'添加所选成员'}</button>
  </>;
}

/* 项目对象页：从弹窗搬到页面内，保留原 Panel / Table / detail 语言，返回列表用页面导航而不是关闭弹窗。 */
export function ProjectDetails({projectId,edit,data,run,onAdd,onBack}:{projectId:string;edit:Editors;data:PlatformSnapshot;run:RunCommand;onAdd:()=>void;onBack:()=>void}){
  const [value,setValue]=useState<ProjectDetail|null>(null),[error,setError]=useState(''),[collectedAt,setCollectedAt]=useState(''),[busy,setBusy]=useState(false);
  async function load(){setBusy(true);try{const next=await api<ProjectDetail>(`/api/v1/platform/projects/${encodeURIComponent(projectId)}`);setValue(next);setCollectedAt(new Date().toISOString());setError('');}catch(e){setError(e instanceof Error?e.message:'读取失败');}finally{setBusy(false);}}
  useEffect(()=>{void load();},[projectId,data]);
  const back=<button type="button" className="link-button" onClick={onBack}>← 返回项目列表</button>;
  if(!value)return <>{back}<Panel title="项目"><p role="status">{error||'正在读取项目资金与成员…'}</p>{error&&<button className="ghost" onClick={()=>void load()}>重新读取</button>}</Panel></>;
  const {project:p,members,budgets,consumedByBatch:spent}=value,batches=members.flatMap(m=>m.batches);
  const consumed=(rows:BusinessQuotaBatch[])=>sum(rows.map(b=>spent[b.id]??0)),pending=(rows:BusinessQuotaBatch[])=>sum(rows.map(b=>Math.max(0,Number((b.totalAmount-b.availableAmount-(b.closedAmount??0)-(spent[b.id]??0)).toFixed(6)))));
  return <>{back}
    <Panel title={p.name} eyebrow="项目" actions={<><Status value={p.status} label={projectStatus[p.status]}/><button className="ghost" disabled={busy} onClick={()=>void load()}>{busy?'正在刷新…':'刷新详情'}</button></>}>
      <p className="secondary">经理：{value.managerName} · {value.canManage?'你可以管理成员与额度':p.memberIds.includes(data.actor.id)?'你是项目成员':'你以申请人身份查看'} · 成员 {p.memberIds.length} 人</p>{error&&<p className="notice danger">{error}</p>}
      {p.description&&<p>{p.description}</p>}
      <p className="secondary">可用模型：{value.models.map(m=>m.name).join('、')||'当前没有可用模型'}。</p>
      <div className="project-summary">{(p.status==='ended'?[['已确认消费',consumed(batches)],['结束已回收',sum([...budgets,...batches].map(b=>b.closedAmount??0))]]:value.canManage?[['可分配给成员',sum(budgets.filter(b=>Date.parse(b.expiresAt)>Date.now()).map(b=>b.availableAmount))],['成员剩余额度',sum(batches.filter(b=>Date.parse(b.expiresAt)>Date.now()).map(b=>b.availableAmount))]]:[['我的剩余额度',sum(batches.filter(b=>Date.parse(b.expiresAt)>Date.now()).map(b=>b.availableAmount))],['已确认消费',consumed(batches)]]).map(([label,amount])=><div key={String(label)}>{label}<strong>{money(Number(amount))}</strong></div>)}</div>
      {value.canManage&&p.status==='active'&&(()=>{const remaining=sum(budgets.filter(b=>Date.parse(b.expiresAt)>Date.now()).map(b=>b.availableAmount)),current=members.filter(m=>m.active&&m.isMember),unfunded=current.filter(m=>!m.batches.some(b=>!b.closedAt&&Date.parse(b.expiresAt)>Date.now()&&b.availableAmount>0));return <div className="next-step"><h3>{!current.length?'先添加需要使用项目的成员':remaining<=0?'项目没有可分配的额度':unfunded.length?`${unfunded.length} 名成员还没有有效余额`:'可以继续分配项目额度'}</h3><p className="secondary">{!current.length?'添加后，再把项目额度分配给成员。':remaining<=0?'补充项目总额度后，再分配到成员。':unfunded.length?unfunded.map(m=>m.name).join('、'):'项目额度按成员分配，原来源和到期日会保留。'}</p><button className="primary" onClick={()=>!current.length?onAdd():remaining>0?edit.allocate(p,unfunded[0]?.id):data.actor.roles.includes('operator')?edit.fund('project',p):edit.request('project_budget',p.id)}>{!current.length?'添加项目成员':remaining>0?'分配给成员':data.actor.roles.includes('operator')?'补充项目总额度':'申请项目总额度'}</button>{current.length>0&&<button className="link-button" onClick={onAdd}>添加其他成员</button>}</div>;})()}
      {p.closedAt&&<p className="notice">结束时间 {date(p.closedAt)} · {p.closeReason}。在途请求仍按原来源结算；后续释放金额进入结束回收记录。</p>}
      <h3>{value.canManage?'项目成员':'我的项目额度'}</h3>{members.map(m=><details className="member-task" key={m.id}><summary><span>{m.name} <small>{!m.active?'已停用或到期':!m.isMember?'已移出项目':p.status==='ended'?'项目已结束':'项目成员'}</small></span><span>剩余 {money(sum(m.batches.filter(b=>Date.parse(b.expiresAt)>Date.now()).map(b=>b.availableAmount)))}</span></summary><div className="project-summary"><div>已确认消费<strong>{money(consumed(m.batches))}</strong></div><div>预占 / 待核对<strong>{money(pending(m.batches))}</strong></div></div>{value.canManage&&p.status==='active'&&m.active&&m.isMember&&<div className="actions"><button className="ghost" onClick={()=>edit.allocate(p,m.id)}>给 {m.name} 分配额度</button>{m.id!==p.managerId&&<button className="link-button" onClick={()=>{void run('project.members',{projectId:p.id,removeMemberIds:[m.id],memberIds:[]}).then(result=>{if(result!==null)void load();}).catch(e=>setError(e.message));}}>移出项目</button>}</div>}</details>)}
      {!members.length&&<p className="empty">还没有成员。添加成员后可以分配项目额度。</p>}
      <details className="disclosure"><summary>资金来源、消费与回收明细</summary><p className="secondary">读取于 {date(collectedAt)}。项目累计发放只统计总预算。以下为账面余额；能否调用还取决于项目、成员、模型和限制。预占不计入已确认消费。</p><dl className="detail-list"><div><dt>{value.canManage?'项目累计发放':'我的累计分配'}</dt><dd>{money(value.canManage?sum(budgets.map(b=>b.totalAmount)):sum(batches.map(b=>b.totalAmount)))}</dd></div><div><dt>已过期余额</dt><dd>{money(sum([...budgets,...batches].filter(b=>Date.parse(b.expiresAt)<=Date.now()).map(b=>b.availableAmount)))}</dd></div><div><dt>预占 / 待核对</dt><dd>{money(pending(batches))}</dd></div><div><dt>结束回收</dt><dd>{money(sum([...budgets,...batches].map(b=>b.closedAmount??0)))}</dd></div></dl>
      {value.canManage&&<><h3>项目来源预算</h3><Table headers={['来源批次','累计发放','待分配余额','结束回收','原到期日']} rows={budgets.map(b=>[b.id,money(b.totalAmount),money(b.availableAmount),money(b.closedAmount??0),date(b.expiresAt)])} empty="还没有项目预算。补充总额度后才能分配给成员。"/></>}
      <h3>成员来源批次</h3><Table headers={['成员','原始项目批次','累计分配','账面余额','原到期日','状态']} rows={members.flatMap(m=>m.batches.map(b=>[m.name,b.sourceBatchId??'—',money(b.totalAmount),money(b.availableAmount),date(b.expiresAt),b.closedAt?'结束已回收':Date.parse(b.expiresAt)<=Date.now()?'已过期':'保留原期限']))} empty="还没有成员额度批次。分配后在这里查看原期限与回收记录。"/><p className="secondary">移出项目立即阻止该用途新调用；原批次与历史保留，重新加入仍受原期限约束，项目结束时统一回收未使用余额。</p>
      </details>
      {value.canManage&&<details className="disclosure"><summary>项目设置与管理记录</summary>{p.status!=='ended'&&<div className="actions">{data.actor.roles.includes('operator')&&<><button className="ghost" onClick={()=>edit.project(p)}>修改项目与模型范围</button><button className="ghost" onClick={()=>edit.fund('project',p)}>补充项目总额度</button></>}<button className="ghost" onClick={()=>edit.endProject(p)}>结束项目</button></div>}<h3>管理记录</h3><Table headers={['时间','操作人','动作','说明']} rows={value.history.map(h=>[date(h.createdAt),data.members.find(m=>m.id===h.actorId)?.name??h.actorId,({'project.closed':'项目结束回收','project.end':'结束已记录','project.fund':'项目总额度发放','project.allocate':'成员原批次分配','project.members':'成员关系变更','save.project':'项目配置更新'} as Record<string,string>)[h.action]??h.action,h.reason||'—'])} empty="还没有项目管理记录。成员、额度与状态变更会记录在这里。"/></details>}
    </Panel></>;
}

/* 列表页：统计条 + 即时筛选 + 表格。行内只放可比较字段，入口统一为“进入项目”。 */
function ProjectList({data:d,isOps,edit,setPage,staleId}:{data:PlatformSnapshot;isOps:boolean;edit:Editors;setPage:PageProps['setPage'];staleId:string|null}){
  const admin=d.actor.roles.includes('operator'),[query,setQuery]=useState(''),[status,setStatus]=useState(''),[scope,setScope]=useState('');
  const name=(id:string)=>d.members.find(m=>m.id===id)?.name??id;
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
    if(admin)return {main:money(sum(budgets.map(b=>b.availableAmount))),help:`成员剩余 ${money(sum(d.quotaBatches.filter(b=>b.projectId===p.id&&b.purpose==='project'&&live(b)).map(b=>b.availableAmount)))}`};
    if(p.managerId===d.actor.id)return {main:money(sum(budgets.map(b=>b.availableAmount))),help:'待分配给成员'};
    if(p.memberIds.includes(d.actor.id))return {main:money(sum(d.quotaBatches.filter(b=>b.projectId===p.id&&b.purpose==='project'&&live(b)).map(b=>b.availableAmount))),help:'我的项目额度'};
    return {main:'—',help:'未加入成员'};
  }
  const emptyState=d.projects.length?<div className="empty-state"><strong>没有符合当前条件的项目</strong><p>已设置 {activeCount} 项筛选条件。可以清除筛选，或换一个状态与范围再查。</p><div className="actions"><button className="ghost" onClick={clear}>清除筛选</button></div></div>:<div className="empty-state"><strong>还没有项目</strong><p>{isOps?'项目为一组成员承载共同额度。创建项目后发放总额度、添加成员，再按成员分配。':'你还没有参与任何项目。个人日常办公与编程无需先建项目；需要部门共享额度时，由运营创建项目并把你加入。'}</p></div>;
  return <>
    {staleId&&<p className="notice warning">该项目已不在你的权限范围内，已返回项目列表。</p>}
    <Panel title={isOps?'项目运营':'我的项目'} actions={<button className="primary" onClick={()=>isOps?edit.project():edit.request('project_create')}>{isOps?'创建项目':'申请创建项目'}</button>}>
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
        return [
          <>{p.name}<small className="cell-help">{p.description||'无说明'}</small></>,
          <><Status value={p.status} label={projectStatus[p.status]}/>{p.status==='ended'&&p.closedAt&&<small className="cell-help">{date(p.closedAt)} 结束</small>}</>,
          <>{name(p.managerId)}{p.managerId===d.actor.id&&<small className="cell-help">我负责</small>}</>,
          `${p.memberIds.length} 人`,
          <>{amount.main}<small className="cell-help">{amount.help}</small></>,
          <div className="inline-actions"><button onClick={()=>setPage('projects',p.id)}>{p.status==='ended'?'查看结束记录':manage?'管理项目':'查看我的额度'}</button>{p.status==='active'&&manage&&admin&&<button onClick={()=>edit.fund('project',p)}>补充额度</button>}{p.status==='active'&&manage&&!admin&&<button onClick={()=>edit.request('project_budget',p.id)}>申请额度</button>}{p.status==='active'&&!manage&&member&&<button onClick={()=>edit.request('project_member_quota',p.id)}>申请额度</button>}</div>,
        ];
      })}/>
    </Panel>
  </>;
}

export function Projects({data:d,isOps,edit,run,detail,setPage,targetId}:{data:PlatformSnapshot;isOps:boolean;edit:Editors;run:RunCommand;detail:Detail;setPage:PageProps['setPage'];targetId?:string|null}){
  const project=targetId?d.projects.find(p=>p.id===targetId):undefined;
  if(project)return <ProjectDetails projectId={project.id} edit={edit} data={d} run={run} onBack={()=>setPage('projects')} onAdd={()=>detail('添加项目成员',<ProjectMemberPicker projectId={project.id} run={run}/>)}/>;
  return <ProjectList data={d} isOps={isOps} edit={edit} setPage={setPage} staleId={targetId??null}/>;
}
