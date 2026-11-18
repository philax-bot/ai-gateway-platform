import {useState} from 'react';
import {api} from './client';
import {hasPermission} from '@ai-gateway/contracts';
import {MODEL_KINDS,BUILTIN_PROVIDERS,modelProviders,type ModelKind,type ModelProvider,type ModelService,type PlatformSnapshot,type PublicUpstreamCredential} from '@ai-gateway/contracts';
import {Panel,Table,Status,date} from './components';
import {markTint,providerHost,providerMark} from './provider-mark';
import {CapabilityMatrix,type CapabilityState} from './model-surface';
import type {PageProps} from './WorkspacePages';

type Props=Pick<PageProps,'data'|'edit'|'setPage'|'detail'|'targetId'>;
const isBuiltin=(id:string)=>BUILTIN_PROVIDERS.some(item=>item.id===id);

function servicesOf(d:PlatformSnapshot,providerId:string){return d.services.filter(service=>(service.providerId??'openai-compatible')===providerId);}
function verifiedCount(services:ModelService[]){return services.filter(service=>service.active&&service.verification==='passed').length;}
function lastVerifiedAt(services:ModelService[]){return services.map(service=>service.verifiedAt).filter((value):value is string=>!!value).sort().at(-1);}

/* 类型 × 三态：模板声明的是“适用类型”，只有当前有通过验证的同类型服务才算“已确认”。 */
function capabilityStates(d:PlatformSnapshot,provider:ModelProvider,services:ModelService[]):Partial<Record<ModelKind,CapabilityState>>{
  const confirmed=new Set<ModelKind>();
  for(const service of services.filter(item=>item.active&&item.verification==='passed')){
    for(const mapping of service.mappings){
      const kind=d.definitions.find(definition=>definition.id===mapping.definitionId)?.kind??'chat';
      confirmed.add(kind);
    }
  }
  return Object.fromEntries(provider.kinds.map(kind=>[kind,confirmed.has(kind)?'verified':'declared'])) as Partial<Record<ModelKind,CapabilityState>>;
}

/* 版本使用记录：只统计已转发的调用，目录检查与内部诊断不计入（沿用原有口径）。 */
function showCredentialUsage(detail:Props['detail'],id:string){
  void api<{items:{version:number;calls:number;failures:number;lastUsedAt:string}[]}>(`/api/v1/platform/upstream-credentials/${encodeURIComponent(id)}/usage`)
    .then(result=>detail('上游凭据使用记录',<><p className="secondary">按准入时绑定版本汇总已转发调用，不包含目录检查和内部诊断。</p><Table headers={['版本','调用数','异常调用','最近使用']} rows={result.items.map(row=>[`v${row.version}`,row.calls,row.failures,date(row.lastUsedAt)])} empty="该凭据还没有已结束的已转发调用。"/></>))
    .catch(cause=>detail('上游凭据使用记录',<p className="notice danger" role="alert">{cause instanceof Error?cause.message:'使用记录读取失败'}</p>));
}

function providerIdentity(provider:ModelProvider){
  const mark=providerMark(provider.id,provider.name);
  return <span className="provider-cell-name">
    <span className="provider-mark" style={{background:markTint(mark.color),color:mark.color}} aria-hidden="true">{mark.label}</span>
    <span><b>{provider.name}</b><small className="cell-help">{provider.description}</small><small className="cell-help">{isBuiltin(provider.id)?'内置模板':'自定义供应商'}</small></span>
  </span>;
}

function kindTags(kinds:ModelKind[]){
  return <span className="provider-kinds">{kinds.slice(0,3).map(kind=><span className="tag" key={kind}>{MODEL_KINDS[kind]}</span>)}{kinds.length>3&&<span className="tag">+{kinds.length-3}</span>}</span>;
}

export function Providers({data:d,edit,setPage,detail,targetId}:Props){
  const [query,setQuery]=useState(''),[connection,setConnection]=useState(''),[kind,setKind]=useState('');
  const writable=hasPermission(d.actor,'models.write'),credentialRead=hasPermission(d.actor,'credentials.read'),credentialWrite=hasPermission(d.actor,'credentials.write');
  const providers=modelProviders(d.providers);
  if(!hasPermission(d.actor,'models.read'))return <Panel title="供应商"><p role="alert">供应商配置仅供运营管理。</p><button className="ghost" onClick={()=>setPage('home')}>返回首页</button></Panel>;
  const selected=targetId?providers.find(provider=>provider.id===targetId):undefined;
  if(selected)return <ProviderDetails provider={selected} data={d} edit={edit} setPage={setPage} detail={detail}/>;
  return <ProviderList data={d} providers={providers} staleId={targetId??null} query={query} setQuery={setQuery} connection={connection} setConnection={setConnection} kind={kind} setKind={setKind} writable={writable} credentialRead={credentialRead} credentialWrite={credentialWrite} edit={edit} setPage={setPage} detail={detail}/>;
}

function ProviderList({data:d,providers,staleId,query,setQuery,connection,setConnection,kind,setKind,writable,credentialRead,credentialWrite,edit,setPage,detail}:{
  data:PlatformSnapshot;providers:ModelProvider[];staleId:string|null;query:string;setQuery:(value:string)=>void;connection:string;setConnection:(value:string)=>void;kind:string;setKind:(value:string)=>void;
  writable:boolean;credentialRead:boolean;credentialWrite:boolean;edit:Props['edit'];setPage:Props['setPage'];detail:Props['detail'];
}){
  const connectedCount=providers.filter(provider=>servicesOf(d,provider.id).length>0).length;
  const pendingVerify=d.services.filter(service=>service.active&&service.verification!=='passed').length;
  const filtered=providers.filter(provider=>{
    const services=servicesOf(d,provider.id),search=query.trim().toLocaleLowerCase();
    if(search&&![provider.name,provider.description,provider.baseUrl].some(value=>value?.toLocaleLowerCase().includes(search)))return false;
    if(kind&&!provider.kinds.includes(kind as ModelKind))return false;
    if(connection==='connected'&&!services.length)return false;
    if(connection==='idle'&&services.length)return false;
    if(connection==='disabled'&&provider.active)return false;
    return true;
  });
  const searching=!!(query.trim()||connection||kind),filters=[query.trim()?'搜索':'',connection?'接入状态':'',kind?'模型类型':''].filter(Boolean).length;
  const connected=filtered.filter(provider=>provider.active&&servicesOf(d,provider.id).length>0),idleCustom=filtered.filter(provider=>provider.active&&!servicesOf(d,provider.id).length&&!isBuiltin(provider.id));
  const idleBuiltin=filtered.filter(provider=>provider.active&&!servicesOf(d,provider.id).length&&isBuiltin(provider.id)),disabled=filtered.filter(provider=>!provider.active);
  const mainRows=searching?filtered:[...connected,...idleCustom,...disabled];
  const templateRows=searching?[]:idleBuiltin;
  const clear=()=>{setQuery('');setConnection('');setKind('');};
  const row=(provider:ModelProvider)=>{
    const services=servicesOf(d,provider.id),verified=verifiedCount(services),verifiedAt=lastVerifiedAt(services);
    return [
      providerIdentity(provider),
      kindTags(provider.kinds),
      services.length?<>{services.length} 个服务<small className="cell-help">{verified} 个已验证</small></>:<span className="quiet-state">未接入</span>,
      verifiedAt?<>{date(verifiedAt)}<small className="cell-help">最近一次连接验证</small></>:<span className="quiet-state">—</span>,
      provider.active?<span className="quiet-state">启用</span>:<Status value="disabled"/>,
      <button type="button" className="link-button" onClick={()=>setPage('providers',provider.id)}>详情 ›</button>,
    ];
  };
  const headers=['供应商','能力','连接','最近验证','状态','操作'];
  const emptyState=providers.length
    ?<div className="empty-state"><strong>没有符合条件的供应商</strong><p>已设置 {filters} 项筛选条件。可以清除筛选，或换一个接入状态与模型类型再查。</p><div className="actions"><button type="button" className="ghost" onClick={clear}>清除筛选</button></div></div>
    :<div className="empty-state"><strong>还没有供应商</strong><p>供应商是接入服务的来源模板。可以从内置模板开始，也可以创建自定义供应商后再接入服务。</p><div className="actions"><button type="button" className="ghost" disabled={!writable} onClick={()=>edit.provider()}>创建供应商</button></div></div>;
  return <>
    {staleId&&<p className="notice warning">该供应商已不在你的权限范围或已被删除，已返回供应商列表。</p>}
    <Panel title="供应商与接入" actions={<>
      <button type="button" className="ghost" disabled={!writable} onClick={()=>edit.provider()}>创建供应商</button>
      <button type="button" className="primary" disabled={!writable} onClick={()=>edit.service()}>接入模型服务</button>
    </>}>
      <p className="secondary">从供应商接入模型服务，再登记模型、验证连接并加入模型池。默认先看已接入的来源；尚未接入的内置模板折叠在下方。</p>
      <div className="metric-grid">
        <article className="metric"><span>供应商</span><strong>{providers.length}</strong><small>内置 {providers.filter(provider=>isBuiltin(provider.id)).length} · 自定义 {providers.filter(provider=>!isBuiltin(provider.id)).length}</small></article>
        <article className="metric"><span>已接通</span><strong>{connectedCount}</strong><small>至少有一个服务连接</small></article>
        <article className="metric"><span>服务连接</span><strong>{d.services.length}</strong><small>{verifiedCount(d.services)} 个已启用且验证通过</small></article>
        <article className={`metric ${pendingVerify?'is-alert':''}`}><span>待验证服务</span><strong>{pendingVerify}</strong><small>{pendingVerify?'连接未通过或尚未验证':'当前没有待验证连接'}</small></article>
      </div>
      <form className="call-filters call-filter-form" onSubmit={event=>event.preventDefault()}>
        <div className="filter-primary">
          <label>搜索供应商<input value={query} placeholder="名称、说明或服务地址" onChange={event=>setQuery(event.target.value)}/></label>
          <label>接入状态<select value={connection} onChange={event=>setConnection(event.target.value)}><option value="">全部供应商</option><option value="connected">已接入服务</option><option value="idle">尚未接入</option><option value="disabled">已停用</option></select></label>
          <label>模型类型<select value={kind} onChange={event=>setKind(event.target.value)}><option value="">全部类型</option>{Object.entries(MODEL_KINDS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <div className="filter-actions">
          <span className="filter-state" role="status">即时筛选 · 显示 {mainRows.length+templateRows.length} / {providers.length} 个供应商{filters?` · 已设置 ${filters} 项条件`:''}</span>
          <button type="button" className="ghost" disabled={!filters} onClick={clear}>清除筛选</button>
        </div>
      </form>
      <Table headers={headers} rows={mainRows.map(row)} empty={emptyState}/>
      {templateRows.length>0&&<details className="disclosure">
        <summary>尚未接入的内置模板 · {templateRows.length}</summary>
        <p className="secondary">这些模板只是接入起点，还没有服务连接。选中后进入下一步填写服务地址与凭据。</p>
        <Table headers={headers} rows={templateRows.map(row)}/>
      </details>}
      <p className="secondary">支持类型代表适配范围；具体模型与供应商能力需实际验证。接入服务时可选择或新建托管上游凭据，密钥加密保存。</p>
      {credentialRead&&<div className="actions">
        <button type="button" className="ghost" disabled={!credentialWrite} onClick={()=>edit.upstreamCredential()}>创建上游凭据</button>
        <button type="button" className="link-button" onClick={()=>detail('全部上游凭据',<CredentialTable data={d} items={(d.upstreamCredentials??[]).filter(item=>!item.serviceId)} writable={credentialWrite} onRotate={item=>edit.upstreamCredential(item)} detail={detail}/>)}>查看全部托管凭据 ›</button>
      </div>}
    </Panel>
  </>;
}

function ProviderDetails({provider,data:d,edit,setPage,detail}:{provider:ModelProvider;data:PlatformSnapshot;edit:Props['edit'];setPage:Props['setPage'];detail:Props['detail']}){
  const writable=hasPermission(d.actor,'models.write'),credentialRead=hasPermission(d.actor,'credentials.read'),credentialWrite=hasPermission(d.actor,'credentials.write');
  const services=servicesOf(d,provider.id),verified=verifiedCount(services),verifiedAt=lastVerifiedAt(services);
  const credentials=(d.upstreamCredentials??[]).filter(item=>item.providerId===provider.id&&!item.serviceId);
  const matrix=[{name:provider.name,states:capabilityStates(d,provider,services)}];
  const blockers=[services.length?`${services.length} 个模型服务`:'',credentials.length?`${credentials.length} 个上游凭据`:''].filter(Boolean).join('、');
  return <>
    <button type="button" className="link-button" onClick={()=>setPage('providers')}>← 返回供应商</button>
    <Panel title={provider.name} eyebrow="供应商" actions={<>
      <Status value={provider.active?'active':'disabled'}/>
      <button type="button" className="ghost" disabled={!writable} onClick={()=>edit.provider(provider)}>编辑配置</button>
      <button type="button" className="primary" disabled={!writable||!provider.active} title={!provider.active?'供应商已停用，启用后才能接入新服务':undefined} onClick={()=>edit.service(undefined,undefined,provider.id)}>接入服务</button>
    </>}>
      <p className="secondary">{provider.description||'未填写说明'} · 默认地址 {provider.baseUrl?providerHost(provider.baseUrl):'接入服务时填写'}</p>
      <dl className="detail-lead">
        <div><dt>接口适配器</dt><dd>{provider.adapter}</dd></div>
        <div><dt>服务连接</dt><dd>{services.length}</dd></div>
        <div><dt>已验证</dt><dd>{verified}</dd></div>
        <div><dt>最近验证</dt><dd>{verifiedAt?date(verifiedAt):'未验证'}</dd></div>
      </dl>
      <h3>接入类型与确认状态</h3>
      <CapabilityMatrix rows={matrix} label={`${provider.name} 接入能力`}/>
      <p className="secondary">类型来自供应商模板；只有当前有通过连接验证的同类型模型服务时，才记为已确认。矩阵不表示实时健康。</p>
      <h3>服务连接</h3>
      <Table headers={['服务 / 映射模型','状态','连接验证','托管凭据','操作']} rows={services.map(service=>{
        const credential=(d.upstreamCredentials??[]).find(item=>item.id===service.credentialId);
        return [
          <>{service.name}<small className="cell-help">{service.baseUrl}</small><small className="cell-help">{service.mappings.map(mapping=>d.definitions.find(definition=>definition.id===mapping.definitionId)?.name??mapping.definitionId).join('、')||'未映射模型'}</small></>,
          service.active?<span className="quiet-state">启用</span>:<Status value="disabled"/>,
          <><Status value={service.verification}/><small className="cell-help">{service.verifiedAt?date(service.verifiedAt):'尚未验证'}</small></>,
          service.credentialId?(credential?<>{credential.name}<small className="cell-help">v{credential.currentVersion}{credential.active?'':' · 已停用'}</small></>:'自定义密钥（仅当前服务）'):service.credentialRef?<small className="cell-help">环境变量 {service.credentialRef}</small>:<span className="quiet-state">无需凭据</span>,
          <div className="inline-actions"><button type="button" disabled={!writable} onClick={()=>edit.service(service)}>编辑服务</button><button type="button" onClick={()=>setPage('models')}>验证与记录</button></div>,
        ];
      })} empty={<div className="empty-state"><strong>还没有服务连接</strong><p>接入服务时填写地址、选择凭据并映射模型；保存后需要验证连接才能开放。</p><div className="actions"><button type="button" className="ghost" disabled={!writable||!provider.active} onClick={()=>edit.service(undefined,undefined,provider.id)}>接入服务</button></div></div>}/>
      <p className="secondary">验证、协议探测、计价与模型映射在“模型服务”页维护；这里只汇总当前供应商下的连接现状。</p>
      {credentialRead&&<>
        <h3>托管凭据</h3>
        <CredentialTable data={d} items={credentials} writable={credentialWrite} onRotate={item=>edit.upstreamCredential(item)} detail={detail}/>
        <p className="secondary">轮换创建新版本并要求关联服务重新验证。已准入请求和视频任务继续使用原版本，禁用阻止新调用。</p>
      </>}
      <h3>接入说明</h3>
      <dl className="detail-list">
        <div><dt>默认服务地址</dt><dd>{provider.baseUrl||'接入服务时填写'}</dd></div>
        <div><dt>接口适配器</dt><dd>{provider.adapter} · 由供应商模板预填，接入时仍可修改</dd></div>
        <div><dt>类型范围</dt><dd>{provider.kinds.map(value=>MODEL_KINDS[value]).join('、')}</dd></div>
        <div><dt>来源</dt><dd>{isBuiltin(provider.id)?'内置模板；可编辑后恢复默认':'自定义供应商'}</dd></div>
      </dl>
      <div className="actions">
        <button type="button" className="danger-button" disabled={!writable||!!blockers} title={blockers?`请先迁移或停用：${blockers}`:undefined} onClick={()=>edit.providerDelete(provider)}>{isBuiltin(provider.id)?'恢复默认配置':'删除供应商'}</button>
        <button type="button" className="link-button" onClick={()=>detail('全部上游凭据',<CredentialTable data={d} items={(d.upstreamCredentials??[]).filter(item=>!item.serviceId)} writable={credentialWrite} onRotate={item=>edit.upstreamCredential(item)} detail={detail}/>)}>查看全部托管凭据 ›</button>
      </div>
      <p className="secondary">{blockers?`当前仍有关联：${blockers}，需要先迁移或停用后才能删除。`:'删除只影响后续选择；历史调用、审计与已发布路由保留。'}</p>
    </Panel>
  </>;
}

function CredentialTable({data:d,items,writable,onRotate,detail}:{data:PlatformSnapshot;items:PublicUpstreamCredential[];writable:boolean;onRotate:(item:PublicUpstreamCredential)=>void;detail:Props['detail']}){
  const providers=modelProviders(d.providers);
  return <Table headers={['凭据 / 供应商','当前版本 / 掩码','允许新调用','关联服务','更新时间','操作']} rows={items.map(item=>[
    <>{item.name}<small className="cell-help">{providers.find(provider=>provider.id===item.providerId)?.name??item.providerId}</small></>,
    <>v{item.currentVersion}<small className="cell-help">{item.versions.find(version=>version.version===item.currentVersion)?.masked??'未知'}</small></>,
    item.active?<span className="quiet-state">启用</span>:<Status value="disabled"/>,
    d.services.filter(service=>service.credentialId===item.id).map(service=>service.name).join('、')||'尚未关联',
    date(item.updatedAt),
    <div className="inline-actions"><button type="button" className="link-button" disabled={!writable} onClick={()=>onRotate(item)}>{writable?'轮换 / 状态':'只读'}</button><button type="button" className="link-button" onClick={()=>showCredentialUsage(detail,item.id)}>版本使用记录</button></div>,
  ])} empty="还没有托管凭据。创建后可被多个服务选用；服务内自定义密钥不在此列出。"/>;
}
