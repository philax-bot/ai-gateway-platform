import { useEffect,useState,type ReactNode } from 'react';
import type { AuditEntry,CallPage,ModelRange,PlatformSnapshot,UsageLimits } from '@ai-gateway/contracts';
import { api,openAiBaseUrl } from './client';
import { date,money,Panel,Status,Table,toDateInput } from './components';
import { DateField } from './date-field';
import type { makeEditors } from './editors';
import {organizationPath,organizationTree} from './organizations';
type Key=PlatformSnapshot['keys'][number];
interface KeyDetail {key:Key;ownerName:string;sourceActive:boolean;models:{modelId:string;name:string}[];sources:{name:string;poolName:string;range:ModelRange;limits:UsageLimits;expiresAt:string|null;planVersion:number|null;balance:number}[];protections:{name:string;limits:UsageLimits}[];calls:CallPage;history:AuditEntry[]}
const purposes:Record<string,string>={personal:'个人 · 日常办公',project:'项目成员',application:'独立应用'};
function limitsText(l:UsageLimits){return l.mode==='inherit'?'继承企业默认':l.mode==='none'?'本级不额外限制':[['RPM',l.rpm],['TPM',l.tpm],['并发',l.concurrency],['单次输出',l.maxOutputTokens]].filter(([,value])=>value!==undefined).map(([key,value])=>`${key} ${value}`).join(' · ');}
export function KeyDetails({keyId,data,guideOnly=false}:{keyId:string;data:PlatformSnapshot;guideOnly?:boolean}){
  const [value,setValue]=useState<KeyDetail|null>(null),[error,setError]=useState(''),[selected,setSelected]=useState('');
  useEffect(()=>{let disposed=false;setError('');void api<KeyDetail>(`/api/v1/platform/keys/${encodeURIComponent(keyId)}`).then(v=>{if(!disposed){setValue(v);setSelected(current=>v.models.some(m=>m.modelId===current)?current:v.models[0]?.modelId??'');}}).catch(e=>{if(!disposed)setError(e instanceof Error?e.message:'读取失败');});return()=>{disposed=true;};},[keyId,data.revision]);
  if(error)return <div role="alert" className="notice danger">{error}</div>;if(!value)return <p role="status">正在读取密钥用途与接入配置…</p>;
  const {key:k}=value,active=k.status==='active'&&Date.parse(k.expiresAt)>Date.now()&&value.sourceActive;
  const example=[`$headers = @{ Authorization = "Bearer $env:AI_API_KEY" }`,"$body = @'",JSON.stringify({model:selected,messages:[{role:'user',content:'你好'}],max_tokens:32},null,2),"'@",`Invoke-RestMethod -Method Post -Uri '${`${openAiBaseUrl}/chat/completions`.replace(/'/g,"''")}' -Headers $headers -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body))`].join('\n');
  return <><p>{k.name} · <code>{k.masked}</code> · {purposes[k.purpose]} · 所有者 {value.ownerName}</p>{!active&&<div className="notice warning">密钥或用途当前停用 / 到期，不能发起新调用。修改工具配置不会恢复权益。</div>}
    <h3>编程工具接入</h3><ol><li>选择支持 OpenAI Chat Completions 的服务商或自定义入口。</li><li>Base URL 填写 <code>{openAiBaseUrl}</code>；API Key 填写签发时保存的完整值。</li><li>从下方选择本用途开放的模型标识；先发一次简短请求，再按请求编号查看费用和调用结果。</li></ol>
    <label>本密钥可见模型<select value={selected} onChange={e=>setSelected(e.target.value)}>{value.models.map(m=><option key={m.modelId} value={m.modelId}>{m.name} · {m.modelId}</option>)}</select></label>
    {!value.models.length?<p className="notice warning">当前没有开放模型。请检查用途权益及模型服务，追加金额不能解决模型不可用。</p>:<><p className="secondary">将完整值保存在本机受控的 AI_API_KEY 环境变量。下方 PowerShell 示例读取环境变量，不写入或展示密钥。</p><pre className="code-example">{example}</pre></>}
    <p>多把密钥共享同一人员用途或应用的额度与保护。密钥本身不增加余额；项目用途与个人用途分别扣费。失败时保留请求编号并查看 error.code：401 检查密钥，403 核对用途权益、模型和余额，429 检查使用限制。价格未确认时联系运营核实。</p>
    {!guideOnly&&<><h3>权益与额度来源</h3><Table headers={['来源 / 版本','模型池与范围','有效批次余额','权益期限','来源保护']} rows={value.sources.map(s=>[`${s.name}${s.planVersion===null?'':` · v${s.planVersion}`}`,`${s.poolName} · ${s.range.mode==='follow'?'跟随模型池':'仅指定模型'}`,money(s.balance),date(s.expiresAt),limitsText(s.limits)])}/><p className="secondary">余额为有效来源批次的账面合计；具体模型可消费金额取决于来源范围和单批余额。服务、模型入口与共享容量保护也会继续生效。</p><p>{value.protections.map(p=>`${p.name}：${limitsText(p.limits)}`).join('；')}</p>
      <h3>最近调用</h3><p>历史已结束 {value.calls.summary.ended} 次 · 待核对 {value.calls.summary.pendingReview} 次 · 确认费用 {money(value.calls.summary.confirmedAmount)}。下表为最近 10 条，完整记录可按密钥进入调用日志筛选。</p><Table headers={['请求编号','模型','结果','计费','结束时间']} rows={value.calls.items.map(c=>[c.requestId,c.modelId,<Status value={c.outcome}/>,c.billableState==='confirmed'?money(c.actualAmount):<Status value={c.billableState}/>,date(c.completedAt)])}/>
      <h3>管理记录</h3><Table headers={['时间','操作人','动作','原因']} rows={value.history.map(h=>[date(h.createdAt),data.members.find(m=>m.id===h.actorId)?.name??h.actorId,({'key.issue':'签发密钥','key.status':'密钥状态变更','save.application':'应用交接 / 更新'} as Record<string,string>)[h.action]??h.action,h.reason||'—'])}/></>}
  </>;
}
export function KeyManager({data:d,isOps,edit,detail}:{data:PlatformSnapshot;isOps:boolean;edit:ReturnType<typeof makeEditors>;detail:(title:string,content:ReactNode)=>void}){
  const [query,setQuery]=useState(''),[purpose,setPurpose]=useState(''),[status,setStatus]=useState('');
  const [organizationId,setOrganizationId]=useState(''),[includeChildren,setIncludeChildren]=useState(true),[ownerId,setOwnerId]=useState(''),[expiresFrom,setExpiresFrom]=useState(''),[expiresTo,setExpiresTo]=useState(''),[selected,setSelected]=useState<string[]>([]);
  const owner=(k:Key)=>d.members.find(m=>m.id===k.ownerId)?.name??k.ownerId,object=(k:Key)=>k.purpose==='application'?d.applications.find(a=>a.id===k.subjectId)?.name:k.purpose==='project'?d.projects.find(p=>p.id===k.projectId)?.name:'日常办公';
  const organization=(k:Key)=>k.purpose==='application'?d.applications.find(a=>a.id===k.subjectId)?.organizationId:d.members.find(m=>m.id===k.ownerId)?.organizationId;
  const organizationIds=includeChildren?organizationTree(d.organizations,organizationId):new Set([organizationId]);
  const invalidDates=!!expiresFrom&&!!expiresTo&&expiresFrom>expiresTo;
  const keys=d.keys.filter(k=>!invalidDates&&(!organizationId||organizationIds.has(organization(k)??''))&&(!ownerId||k.ownerId===ownerId)&&(!expiresFrom||toDateInput(k.expiresAt)>=expiresFrom)&&(!expiresTo||toDateInput(k.expiresAt)<=expiresTo)&&(!purpose||k.purpose===purpose)&&(!status||(status==='expired'?Date.parse(k.expiresAt)<=Date.now():k.status===status&&(status!=='active'||Date.parse(k.expiresAt)>Date.now())))&&(!query.trim()||[k.id,k.name,k.masked,owner(k),object(k)??''].some(v=>v.toLowerCase().includes(query.trim().toLowerCase()))));
  useEffect(()=>setSelected([]),[query,purpose,status,organizationId,includeChildren,ownerId,expiresFrom,expiresTo]);
  const selectable=keys.filter(k=>k.status!=='revoked'),selection=selectable.filter(k=>selected.includes(k.id)),atLimit=selection.length>=200;
  function resetFilters(){setQuery('');setPurpose('');setStatus('');setOrganizationId('');setOwnerId('');setExpiresFrom('');setExpiresTo('');setIncludeChildren(true);setSelected([]);}
  const advancedCount=[organizationId,ownerId,expiresFrom,expiresTo].filter(Boolean).length;
  const activeCount=[query,purpose,status,organizationId,ownerId,expiresFrom,expiresTo].filter(Boolean).length;
  return <Panel title={isOps?'全量用途密钥':'接入与密钥'} actions={<button className="primary" onClick={()=>edit.key()}>签发密钥</button>}>
    <p className="secondary">需要让工具停止接入时，先找到对应密钥，再停用或吊销。完整值只在签发时显示，后续无法读取。</p>
    <form className="call-filters call-filter-form" onSubmit={event=>event.preventDefault()}>
      <div className="filter-primary">
        <label>搜索名称 / 所有者 / 用途对象 / 脱敏标识<input value={query} onChange={e=>setQuery(e.target.value)}/></label>
        <label>用途<select value={purpose} onChange={e=>setPurpose(e.target.value)}><option value="">全部</option>{Object.entries(purposes).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        <label>状态<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">全部</option><option value="active">启用</option><option value="disabled">停用</option><option value="revoked">吊销</option><option value="expired">已到期</option></select></label>
      </div>
      <details className="filter-more" open={advancedCount>0||undefined}>
        <summary>按组织、所有者和到期日筛选{advancedCount?` · ${advancedCount} 项`:''}</summary>
        <div className="filter-more-grid">
          <label>所属组织<select value={organizationId} onChange={e=>setOrganizationId(e.target.value)}><option value="">全部组织</option>{d.organizations.map(o=><option key={o.id} value={o.id}>{organizationPath(d.organizations,o.id)}</option>)}</select></label>
          <label>所有者<select value={ownerId} onChange={e=>setOwnerId(e.target.value)}><option value="">全部所有者</option>{[...new Set(d.keys.map(k=>k.ownerId))].map(id=><option key={id} value={id}>{d.members.find(m=>m.id===id)?.name??id}</option>)}</select></label>
          <label>到期日起（北京时间）<DateField value={expiresFrom} onChange={setExpiresFrom} compact/></label>
          <label>到期日止（北京时间）<DateField value={expiresTo} onChange={setExpiresTo} compact/></label>
        </div>
        {organizationId&&<label className="key-check"><input type="checkbox" checked={includeChildren} onChange={e=>setIncludeChildren(e.target.checked)}/>包含下级组织</label>}
        <p className="secondary">个人和项目密钥按人员组织筛选，应用密钥按应用所属组织筛选。</p>
      </details>
      <div className="filter-actions">
        <span className="filter-state" role="status">即时筛选 · 显示 {keys.length} / {d.keys.length} 把{activeCount?` · 已设置 ${activeCount} 项条件`:''}</span>
        <button type="button" className="ghost" onClick={resetFilters}>清除筛选</button>
      </div>
    </form>
    {invalidDates&&<p className="notice warning" role="alert">起始到期日不能晚于结束到期日，请调整日期。</p>}
    {selectable.length>0&&<div className="key-bulk"><label className="key-check"><input type="checkbox" aria-label="选择当前结果中的可管理密钥" checked={selection.length===Math.min(selectable.length,200)&&selection.length>0} onChange={e=>setSelected(e.target.checked?selectable.slice(0,200).map(k=>k.id):[])}/>选择当前结果{selectable.length>200?'中的前 200 把':''}</label><span>已选 {selection.length} 把</span><button disabled={!selection.length} onClick={()=>edit.keysStatus(selection.map(k=>k.id),'disabled')}>批量停用</button><button disabled={!selection.length} onClick={()=>edit.keysStatus(selection.map(k=>k.id),'revoked')}>批量吊销</button>{selection.length>0&&<button className="ghost" onClick={()=>setSelected([])}>取消选择</button>}</div>}
    <Table headers={['选择','名称 / 脱敏标识','所有者 / 组织','用途 / 对象','状态','创建 / 到期 / 最近使用','操作']} empty={d.keys.length?'没有符合筛选条件的密钥，请调整或清除筛选。':'还没有接入密钥。在线使用无需创建；需要连接工具时再签发。'} rows={keys.map(k=>[
      <input type="checkbox" aria-label={`选择密钥 ${k.name}`} disabled={k.status==='revoked'||atLimit&&!selection.some(s=>s.id===k.id)} checked={selection.some(s=>s.id===k.id)} onChange={e=>setSelected(previous=>e.target.checked?[...new Set([...previous,k.id])]:previous.filter(id=>id!==k.id))}/>,
      <>{k.name}<small className="cell-help"><code>{k.masked}</code></small></>,<>{owner(k)}<small className="cell-help">{organizationPath(d.organizations,organization(k)??'未归属组织')}</small></>,`${purposes[k.purpose]} · ${object(k)??'—'}`,<><Status value={k.status}/>{Date.parse(k.expiresAt)<=Date.now()&&<small className="cell-help">已到期</small>}</>,<>创建 {date(k.createdAt)}<small className="cell-help">到期 {date(k.expiresAt)}</small><small className="cell-help">最近使用 {k.lastUsedAt?date(k.lastUsedAt):'尚未使用'}</small></>,<div className="inline-actions"><button onClick={()=>detail('密钥详情与接入',<KeyDetails keyId={k.id} data={d}/>)}>详情与接入</button>{k.status!=='revoked'&&<><button onClick={()=>edit.keyStatus(k.id,k.status==='active'?'disabled':'active')}>{k.status==='active'?'停用':'启用'}</button><button onClick={()=>edit.keyStatus(k.id,'revoked')}>吊销</button></>}</div>
    ])}/><p className="secondary">接入地址 <code>{openAiBaseUrl}</code> · 每次最多处理 200 把；更改筛选会清空选择。停用或吊销不退还额度，已准入请求继续按原预占结算。</p>
  </Panel>;
}
