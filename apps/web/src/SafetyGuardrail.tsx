import {useEffect,useState,type FormEvent} from 'react';
import type {GuardrailPolicy,GuardrailAssessment,PlatformSnapshot,SafetyEvent,SafetyQuery} from '@ai-gateway/contracts';
import {api} from './client';
import {date,Panel,Table,Status,EditorDialog,useNarrow,type Editor} from './components';
import {DateField} from './date-field';
import type {RunCommand} from './editors';

const modes={off:'关闭',observe:'仅记录',block:'拦截'},categories={phone:'疑似手机号',identity_card:'疑似身份证号',api_key:'疑似密钥',custom_word:'自定义禁用词'};
type Report={policy:GuardrailPolicy;items:SafetyEvent[];nextCursor:string|null;counts:{block:number;observe:number}};
const empty={from:'',to:'',modelId:'',subjectId:'',requestId:'',category:'',action:''};
export function SafetyGuardrail({data,run,active=true}:{data:PlatformSnapshot;run:RunCommand;active?:boolean}){
  const [report,setReport]=useState<Report|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[editor,setEditor]=useState<Editor|null>(null),[trial,setTrial]=useState<GuardrailAssessment|null>(null),[message,setMessage]=useState('');
  const [filters,setFilters]=useState(empty),[query,setQuery]=useState<SafetyQuery>({}),[refresh,setRefresh]=useState(0),[previous,setPrevious]=useState<(string|undefined)[]>([]),[filtersOpen,setFiltersOpen]=useState(false),narrow=useNarrow();
  const admin=data.actor.roles.includes('operator');
  useEffect(()=>{if(!admin||!active)return;let disposed=false;setBusy(true);setError('');void api<Report>('/api/v1/platform/safety/query',query).then(value=>{if(!disposed)setReport(value);}).catch(e=>{if(!disposed)setError(e instanceof Error?e.message:'读取安全围栏失败');}).finally(()=>{if(!disposed)setBusy(false);});return()=>{disposed=true;};},[admin,active,data,query,refresh]);
  if(!admin)return <Panel title="安全围栏"><p role="alert">此页面需要运营权限，请联系企业运营。</p></Panel>;
  if(!report)return <Panel title="安全围栏"><p role="status">{error||'正在读取策略和安全事件…'}</p>{error&&<button className="ghost" onClick={()=>setRefresh(n=>n+1)}>重新读取</button>}</Panel>;
  const policy=report.policy,models=data.definitions.map(m=>({value:m.modelId,label:`${m.name} · ${m.modelId}`})),presets=Object.entries(categories).filter(([value])=>value!=='custom_word').map(([value,label])=>({value,label}));
  function configure(){setMessage('');setEditor({title:'调整输入安全围栏',description:'企业统一策略，适用于个人、项目和应用。保存前会核对影响；仅影响后续准入，不改变已发生的调用和费用。',submitLabel:'核对策略影响',initial:{mode:policy.mode,scope:policy.modelIds===null?'all':'specific',modelIds:policy.modelIds??[],presets:policy.presets,words:policy.words.join('\n'),reason:''},fields:[
    {key:'mode',label:'处理模式',type:'choice',required:true,options:Object.entries(modes).map(([value,label])=>({value,label})),help:'仅记录：命中留事件但继续调用；拦截：拒绝外发且不扣费。'},
    {key:'scope',label:'模型范围',type:'choice',required:true,options:[{value:'all',label:'全部模型（含以后新增模型）'},{value:'specific',label:'仅指定模型'}]},
    {key:'modelIds',label:'指定逻辑模型',type:'multiple',options:models,show:v=>v.scope==='specific',requiredWhen:v=>v.scope==='specific'},
    {key:'presets',label:'预置格式规则',type:'multiple',options:presets,help:'识别疑似格式，不证明内容是真实个人信息或有效密钥。'},
    {key:'words',label:'自定义禁用词',type:'textarea',help:'每行一条，2–128 字符，最多 200 条。不区分大小写，不支持正则和语义识别。'},
    {key:'reason',label:'变更原因',type:'textarea',required:true},
  ],submit:async v=>{const result=await run('guardrail.update',{expectedVersion:policy.version,mode:v.mode,modelIds:v.scope==='all'?null:v.modelIds,presets:v.presets,words:String(v.words).split(/\r?\n/).map(w=>w.trim()).filter(Boolean),reason:v.reason},true);if(!result)return false;setMessage('输入安全策略已保存，后续请求按新版本检查。');setTrial(null);setRefresh(n=>n+1);return true;}});}
  function tryRules(){setEditor({title:'试测已保存的规则',description:'请只使用合成测试文本。试测不调用模型，不扣费，不保存文本或生成安全事件；当前模式关闭时仍可测试规则。',submitLabel:'检查合成文本',fields:[{key:'modelId',label:'测试模型',type:'select',options:models,required:true},{key:'text',label:'合成测试文本',type:'textarea',required:true,help:'最多 16384 字符，不要填写真实隐私或密钥。'}],initial:{modelId:policy.modelIds?.[0]??models[0]?.value??'',text:''},submit:async v=>{const value=await api<{result:GuardrailAssessment}>('/api/v1/platform/safety/trial',{text:v.text,modelId:v.modelId});setTrial(value.result);return true;}});}
  function search(event:FormEvent){event.preventDefault();const q:SafetyQuery={};for(const key of Object.keys(filters)as (keyof typeof filters)[]){const value=filters[key].trim();if(value)(q as Record<string,unknown>)[key]=key==='from'||key==='to'?new Date(value).toISOString():value;}setPrevious([]);setQuery(q);if(narrow)setFiltersOpen(false);}
  const filterCount=Object.values(filters).filter(Boolean).length;
  return <>
    {error&&<div role="alert" className="notice danger">{error} 已保留上次读取结果。<button className="link-button" onClick={()=>setRefresh(n=>n+1)}>重新读取</button></div>}
    {message&&<p role="status" className="notice">{message}</p>}
    <Panel title="输入安全策略" actions={<button className="primary" disabled={busy} onClick={configure}>调整策略</button>}>
      <p><Status value={modes[policy.mode]}/> · 策略版本 {policy.version} · 仅检查输入</p>
      <dl className="detail-list"><div><dt>模型范围</dt><dd>{policy.modelIds===null?'全部模型':policy.modelIds.map(id=>data.definitions.find(d=>d.modelId===id)?.name??id).join('、')}</dd></div><div><dt>预置规则</dt><dd>{policy.presets.map(p=>categories[p]).join('、')||'未启用'}</dd></div><div><dt>自定义规则</dt><dd>{policy.words.length} 条</dd></div><div><dt>最近修改</dt><dd>{policy.updatedAt?date(policy.updatedAt):'尚未配置'}</dd></div></dl>
      <p className="secondary">规则型输入防护。历史消息、工具参数及结果同样检查；输出内容、语义攻击和自动脱敏不在当前范围。</p>
      {policy.mode==='off'&&<p className="notice warning">当前未启用输入防护。配置规则并选择仅记录或拦截后生效。</p>}
      <button className="ghost" disabled={busy||!models.length} onClick={tryRules}>规则试测</button>{!models.length&&<p className="secondary">请先配置至少一个逻辑模型。</p>}
      {trial&&<p role="status" className="notice">{trial.error?'文本超过检查边界，无法完成检测。':trial.matches.length?`命中 ${trial.matches.length} 条：${[...new Set(trial.matches.map(m=>categories[m.category]))].join('、')}`:'所选模型范围内未命中规则；请核对已保存规则和模型范围。'}（试测不调用模型、不扣费）</p>}
    </Panel>
    <Panel title="安全事件" actions={<button className="ghost" disabled={busy} onClick={()=>setRefresh(n=>n+1)}>{busy?'正在读取…':'刷新事件'}</button>}>
      <div className="metric-grid"><div className="metric"><span>拦截事件</span><strong>{report.counts.block}</strong></div><div className="metric"><span>观察事件</span><strong>{report.counts.observe}</strong></div></div><p className="secondary">计数按当前查询范围统计。仅统计实际请求命中事件，不包含规则试测、模型拒答和系统故障；默认不保存正文。</p>
      {narrow&&<button className="ghost" aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(v=>!v)}>筛选 · {filterCount} 项条件</button>}
      <form className="call-filter-form" hidden={narrow&&!filtersOpen} onSubmit={search}><div className="filter-primary">
        <label>处理结果<select value={filters.action} onChange={e=>setFilters(f=>({...f,action:e.target.value}))}><option value="">全部结果</option><option value="block">拦截</option><option value="observe">仅记录</option></select></label>
        <label>命中类别<select value={filters.category} onChange={e=>setFilters(f=>({...f,category:e.target.value}))}><option value="">全部类别</option>{Object.entries(categories).map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></label>
        <label>模型<select value={filters.modelId} onChange={e=>setFilters(f=>({...f,modelId:e.target.value}))}><option value="">全部模型</option>{models.map(m=><option value={m.value} key={m.value}>{m.label}</option>)}</select></label>
        <label>请求编号<input value={filters.requestId} onChange={e=>setFilters(f=>({...f,requestId:e.target.value}))}/></label>
      </div><details className="disclosure"><summary>更多筛选</summary><div className="filter-more"><label>主体编号<input value={filters.subjectId} onChange={e=>setFilters(f=>({...f,subjectId:e.target.value}))}/></label><label>开始时间<DateField value={filters.from} mode="datetime" onChange={value=>setFilters(f=>({...f,from:value}))}/></label><label>截止时间<DateField value={filters.to} mode="datetime" onChange={value=>setFilters(f=>({...f,to:value}))}/></label></div></details><div className="filter-actions"><span>已设置 {filterCount} 项条件</span><button type="button" className="ghost" disabled={busy} onClick={()=>{setFilters(empty);setPrevious([]);setQuery({});}}>清除筛选</button><button className="primary" disabled={busy}>查询事件</button></div></form>
      <Table headers={['时间 / 请求编号','主体 / 用途','模型','处理结果','命中类别 / 规则编号','策略版本']} rows={report.items.map(e=>[<>{date(e.createdAt)}<small className="cell-help">{e.requestId}</small></>,<>{data.members.find(m=>m.id===e.subjectId)?.name??data.applications.find(a=>a.id===e.subjectId)?.name??e.subjectId}<small className="cell-help">{({personal:'个人',project:'项目',application:'应用'}as Record<string,string>)[e.purpose]}</small></>,data.definitions.find(m=>m.modelId===e.modelId)?.name??e.modelId,<Status value={e.action==='block'?'已拦截':'仅记录'}/>,<>{[...new Set(e.matches.map(m=>categories[m.category]))].join('、')}<small className="cell-help">{e.matches.map(m=>m.ruleId).join('、')}</small></>,e.policyVersion])} empty={Object.keys(query).length?'没有符合筛选条件的事件，请清除或调整筛选。':'尚无命中事件。启用规则后通过在线使用或 API 发起请求；规则试测不会产生事件。'}/>
      <div className="actions"><button className="ghost" disabled={busy||!previous.length} onClick={()=>{const cursor=previous.at(-1);setPrevious(v=>v.slice(0,-1));setQuery(q=>({...q,before:cursor}));}}>上一页</button><button className="ghost" disabled={busy||!report.nextCursor} onClick={()=>{setPrevious(v=>[...v,query.before]);setQuery(q=>({...q,before:report.nextCursor!}));}}>下一页</button></div>
    </Panel>
    {editor&&<EditorDialog editor={editor} onClose={()=>setEditor(null)}/>}
  </>;
}
