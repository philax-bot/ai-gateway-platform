import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {AuditPage,AuditQuery,AuditRecord,PlatformSnapshot} from '@ai-gateway/contracts';
import {api} from './client';
import {date,Panel} from './components';
import {DateField} from './date-field';

const empty={search:'',actorId:'',action:'',from:'',to:''};
export function OperationAudit({data,detail}:{data:PlatformSnapshot;detail:(title:string,content:ReactNode)=>void}){
  const [opened,setOpened]=useState(false),[filters,setFilters]=useState(empty),[query,setQuery]=useState<AuditQuery>({limit:20});
  const [page,setPage]=useState<AuditPage|null>(null),[catalog,setCatalog]=useState<Pick<AuditPage,'actors'|'actions'>>({actors:[],actions:[]}),[previous,setPrevious]=useState<(string|undefined)[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const resultStatus=useRef<HTMLParagraphElement>(null),moveToResults=useRef(false);
  const allowed=data.actor.roles.includes('operator');
  useEffect(()=>{if(!opened||!allowed)return;let current=true;setBusy(true);setError('');setPage(null);void api<AuditPage>('/api/v1/platform/audit/query',query).then(value=>{if(current){setPage(value);setCatalog({actors:value.actors,actions:value.actions});}}).catch(error=>{if(current)setError(error instanceof Error?error.message:'操作记录读取失败');}).finally(()=>{if(current)setBusy(false);});return()=>{current=false;};},[opened,allowed,query]);
  useEffect(()=>{if(page&&moveToResults.current){moveToResults.current=false;resultStatus.current?.focus({preventScroll:true});resultStatus.current?.scrollIntoView({block:'start'});}},[page]);
  const field=(key:keyof typeof empty,value:string)=>setFilters(previous=>({...previous,[key]:value}));
  function search(){
    if(filters.from&&filters.to&&filters.from>filters.to){setError('开始日期不能晚于结束日期，请调整后查询。');return;}
    const next:AuditQuery={limit:20};for(const key of ['search','actorId','action']as const)if(filters[key].trim())next[key]=filters[key].trim();
    if(filters.from)next.from=new Date(`${filters.from}T00:00:00+08:00`).toISOString();
    if(filters.to)next.to=new Date(Date.parse(`${filters.to}T23:59:59.999+08:00`)+1).toISOString();
    setPrevious([]);setQuery(next);
  }
  const show=(item:AuditRecord)=>detail('操作记录',<>
    <dl className="detail-list"><div><dt>操作</dt><dd>{item.actionName}</dd></div><div><dt>操作人</dt><dd>{item.actorName}</dd></div><div><dt>时间</dt><dd>{date(item.createdAt)}</dd></div><div><dt>业务对象</dt><dd>{item.objectName}</dd></div><div><dt>处理说明</dt><dd className="request-reason">{item.reason||'未记录处理说明'}</dd></div></dl>
    {item.objectNameSource==='current'&&<p className="secondary">这条较早记录没有名称快照，对象名称根据当前资料显示。</p>}
    <h3>当次记录的执行结果</h3>{item.summary.length?<dl className="detail-list">{item.summary.map((entry,index)=><div key={index}><dt>{entry.label}</dt><dd>{/^\d{4}-\d\d-\d\dT/.test(entry.value)?date(entry.value):entry.value}</dd></div>)}</dl>:<p className="secondary">这条历史记录仅保留操作信息，未记录可展示的执行参数。</p>}
    <details className="disclosure"><summary>排查用标识</summary><dl className="detail-list"><div><dt>记录编号</dt><dd><code>{item.id}</code></dd></div><div><dt>操作标识</dt><dd><code>{item.action}</code></dd></div><div><dt>操作者标识</dt><dd><code>{item.actorId}</code></dd></div><div><dt>对象标识</dt><dd><code>{item.objectId??'未记录'}</code></dd></div></dl></details>
  </>);
  if(!allowed)return null;
  return <Panel title="操作审计" actions={<button className="ghost" onClick={()=>setOpened(value=>!value)}>{opened?'收起操作记录':'查找操作记录'}</button>}>
    <p className="secondary">需要确认谁调整了成员、模型、额度或审批时，再展开查找。覆盖全部已保留历史，不限于最近 500 条；对话正文和完整密钥不在查询内容中。</p>
    {opened&&<>
      <form className="call-filters" onSubmit={event=>{event.preventDefault();search();}}>
        <label>关键词<input placeholder="人员、对象、说明或记录编号" value={filters.search} maxLength={200} onChange={e=>field('search',e.target.value)}/></label>
        <label>操作人<select value={filters.actorId} onChange={e=>field('actorId',e.target.value)}><option value="">全部操作人</option>{catalog.actors.map(actor=><option key={actor.id} value={actor.id}>{actor.name}</option>)}</select></label>
        <label>操作<select value={filters.action} onChange={e=>field('action',e.target.value)}><option value="">全部操作</option>{catalog.actions.slice().sort((a,b)=>a.name.localeCompare(b.name,'zh')).map(action=><option key={action.id} value={action.id}>{action.name}</option>)}</select></label>
        <label>开始日期（北京时间）<DateField value={filters.from} onChange={value=>field('from',value)} compact/></label><label>结束日期（北京时间，含当日）<DateField value={filters.to} onChange={value=>field('to',value)} compact/></label>
        <div className="actions compact"><button className="primary" disabled={busy} type="submit">查询操作记录</button><button className="ghost" disabled={busy} type="button" onClick={()=>{setFilters(empty);setPrevious([]);setQuery({limit:20});}}>清除筛选</button></div>
      </form>
      <div className="section-head"><p role="status" tabIndex={-1} ref={resultStatus}>{busy?'正在查询操作记录…':page?`符合条件 ${page.total} 条 · 本页 ${page.items.length} 条${page.total?` · 第 ${previous.length+1} 页`:''}`:'尚未取得查询结果'}</p><button className="ghost" disabled={busy} onClick={()=>{setPrevious([]);setQuery(current=>({...current,cursor:undefined}));}}>刷新最新记录</button></div>
      {error&&<p className="notice danger" role="alert">{error}</p>}
      {page&&!page.items.length&&<p className="notice">没有符合条件的操作记录，请调整或清除筛选。</p>}
      {page&&<><ol className="audit-records" aria-label="操作记录查询结果">{page.items.map(item=><li key={item.id}>
        <div className="audit-record-head"><strong>{item.actionName}</strong><time dateTime={item.createdAt}>{date(item.createdAt)}</time></div><p>{item.actorName} · {item.objectName}</p><p className="request-reason secondary">{item.reason||'未记录处理说明'}</p><button className="ghost" onClick={()=>show(item)}>查看记录</button>
      </li>)}</ol><div className="audit-pagination"><button className="ghost" disabled={busy||!previous.length} onClick={()=>{moveToResults.current=true;const stack=previous.slice(),cursor=stack.pop();setPrevious(stack);setQuery(current=>({...current,cursor}));}}>上一页</button><button className="ghost" disabled={busy||!page.nextCursor} onClick={()=>{moveToResults.current=true;setPrevious(stack=>[...stack,query.cursor]);setQuery(current=>({...current,cursor:page.nextCursor!}));}}>下一页</button><span>{page.total?`第 ${previous.length+1} / ${Math.ceil(page.total/20)} 页 · 共 ${page.total} 条`:'暂无符合条件的记录'}</span><small>每页 20 条 · 翻页期间固定本次历史范围，新操作可刷新查看。</small></div></>}
    </>}
  </Panel>;
}
