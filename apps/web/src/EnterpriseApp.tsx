import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { EntitlementMigrationPreview, OrganizationChangeImpact, PlatformCommand, PlatformSnapshot,RetentionCounts,RetentionReport } from '@ai-gateway/contracts';
import { api, ApiError, executeCommand, loadWorkspace, previewCommand, type Preview } from './client';
import { date, Modal, money, Status, Table, type Editor } from './components';
import { PasswordInput } from './password-field';
import { CommandPalette, DesignSwitch, SignalMark, V2Header, navIcon, type PaletteItem } from './v2';
import { V3PlatformBar, V3Sidebar, V3TabBar, type NavEntry, type OpenTab } from './v3';
import { V4PageTabs, V4Sidebar, V4TopBar } from './v4';
import { useUiDesign, type UiDesign } from './ui-mode';
import { EditorFlow } from './EditorFlow';
import { makeEditors } from './editors';
import { WorkspacePages, type DetailContent } from './WorkspacePages';
import { responsible } from './ApprovalCenter';
import { AlertWatcher } from './AlertWatcher';
import { KeyDetails } from './KeyManager';
import { OrganizationImpact } from './OrganizationImpact';
import {RetentionCountsView,retentionTotal} from './RetentionSettings';

const labels:Record<string,string>={overview:'运营工作台',models:'模型配置',catalog:'模型目录',members:'组织与成员',onboarding:'为人员开通',projects:'项目',applications:'应用',keys:'密钥与接入',approvals:'申请与审批',calls:'调用记录',reviews:'费用核对',monitoring:'运行监控',safety:'安全围栏',settings:'企业设置',home:'开始使用',quota:'我的额度',online:'在线使用',notifications:'通知'};
/* One line per page: what this page is for and what the numbers mean. Shown under
   the page title so an operator does not have to read the panel text to orient. */
const ledes:Record<string,string>={
  overview:'需要你处理的事项、下一步建议，以及当前运营口径下的关键数字。',
  catalog:'查看已登记模型的来源、配置价格和开放范围，按需进入原配置流程。',
  models:'模型服务、模型池与开放范围。只有连接验证通过且价格已确认的服务才能开放给同事。',
  members:'组织决定权限边界，成员状态决定能否登录和接受开通。',
  onboarding:'选择人员和方案，确认金额与到期日后开通。开通不创建密钥，也不迁移已有权益。',
  projects:'项目承载一组成员的共同额度；项目结束时回收未使用余额。',
  applications:'应用使用独立额度与密钥，适合服务端接入；负责人可自行管理接入凭据。',
  keys:'密钥只用于工具接入，本身不增加余额。完整值仅在签发时显示一次。',
  approvals:'按你的审批职责显示申请。批准只表示同意，执行结果单独记录。',
  calls:'每次已结束调用的结果、用量与计费依据。默认不保存、不展示正文。',
  reviews:'上游未返回完整用量时保留预占，需要人工核对之后才结算。',
  safety:'企业统一的输入规则、仅记录与拦截，以及不含正文的安全事件。',
  monitoring:'服务健康、上游连通与采集状态。没有流量不代表健康。',
  settings:'企业名称、默认模型池、默认使用保护与数据保留。变更只影响后续请求。',
  home:'你当前可用的模型与额度。在线使用不需要先创建密钥。',
  quota:'按用途查看额度来源、剩余金额，以及一次调用能使用的上限。',
  online:'直接发起一次调用，结果与费用可在调用记录中追溯到同一请求编号。',
  notifications:'审批结果、额度变化与运行告警的通知，可在原页面打开对应对象。',
};
const actions:Record<string,string>={'guardrail.update':'保存输入安全策略','save.organization':'保存组织','save.definition':'保存模型定义','approval.repair':'修正执行参数','save.rule':'保存开通规则','auto.apply':'应用规则到现有成员','import.members':'导入成员','save.pool':'确认模型池范围','project.fund':'发放项目总额度','project.allocate':'分配项目成员额度','application.fund':'发放应用额度','distribution.execute':'批量开通','key.status':'调整密钥状态','key.issue':'签发用途密钥','save.member':'保存成员','save.service':'保存模型服务','save.project':'保存项目','save.application':'保存应用','save.plan':'保存个人方案','approval.decide':'处理审批','approval.execute':'执行已批准事项'};
type Pending={command:PlatformCommand;preview:Preview;resolve:(value:unknown|null)=>void;reject:(error:unknown)=>void};

export function EnterpriseApp(){
  const [data,setData]=useState<PlatformSnapshot|null>(null),[loading,setLoading]=useState(true),[setup,setSetup]=useState(false),[setupTokenRequired,setSetupTokenRequired]=useState(false);
  const [page,setPage]=useState('home'),[operations,setOperations]=useState(false),[message,setMessage]=useState('');
  const [targetId,setTargetId]=useState<string|null>(null);
  const [openTabs,setOpenTabs]=useState<OpenTab[]>([]),[menuOpen,setMenuOpen]=useState(false),[narrow,setNarrow]=useState(false);
  const menuButtonRef=useRef<HTMLButtonElement>(null);
  function closeMenu(){setMenuOpen(false);window.setTimeout(()=>menuButtonRef.current?.focus(),20);}
  useEffect(()=>{
    const query=window.matchMedia('(max-width: 900px)'),sync=()=>setNarrow(query.matches);
    sync();query.addEventListener('change',sync);
    return()=>query.removeEventListener('change',sync);
  },[]);
  function navigate(value:string,id?:string){
    setPage(value);setTargetId(id??null);
    setOpenTabs(tabs=>{
      const entry={page:value,targetId:id??null};
      return tabs.some(tab=>tab.page===value)?tabs.map(tab=>tab.page===value?entry:tab):[...tabs,entry].slice(-12);
    });
  }
  const [editor,setEditor]=useState<Editor|null>(null),[pending,setPending]=useState<Pending|null>(null),[busy,setBusy]=useState(false);
  const [detail,setDetail]=useState<{title:string;content:DetailContent}|null>(null),[secret,setSecret]=useState<{value:string;keyId:string|null}|null>(null),[purposeId,setPurposeId]=useState('personal');
  const [uiMode,setUiMode]=useUiDesign(),[paletteOpen,setPaletteOpen]=useState(false);
  const sidebar=uiMode==='sidebar',next=uiMode==='next',azure=uiMode==='azure',beacon=uiMode==='beacon',v4Shell=azure||beacon,docked=sidebar||v4Shell,desk=next||docked;
  useEffect(()=>{
    if(!desk||menuOpen||editor||pending||detail||secret)return;
    const openPalette=(event:KeyboardEvent)=>{
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();setPaletteOpen(open=>!open);}
    };
    window.addEventListener('keydown',openPalette);
    return()=>window.removeEventListener('keydown',openPalette);
  },[desk,menuOpen,editor,pending,detail,secret]);
  useEffect(()=>{
    if(!menuOpen)return;
    const overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const panel=document.getElementById(v4Shell?'v4-sidebar':'v3-sidebar');
    const focusable=()=>panel?[...panel.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]:[];
    const keepFocusInside=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();closeMenu();return;}
      if(event.key!=='Tab')return;
      const items=focusable(),first=items[0],last=items.at(-1);
      if(!first||!last)return;
      const active=document.activeElement,inside=!!panel?.contains(active);
      if(event.shiftKey&&(!inside||active===first)){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&(!inside||active===last)){event.preventDefault();first.focus();}
    };
    window.addEventListener('keydown',keepFocusInside);
    return()=>{document.body.style.overflow=overflow;window.removeEventListener('keydown',keepFocusInside);};
  },[menuOpen]);
  useEffect(()=>{window.scrollTo(0,0);},[page]);
  useEffect(()=>{
    if(!data)return;
    const adminNow=data.actor.roles.includes('operator'),opsNow=operations&&adminNow;
    const valid=opsNow
      ?['overview','onboarding','approvals','projects','applications','catalog','models','members','keys','monitoring','safety','calls','reviews','settings','notifications']
      :['home','online','quota','approvals','keys','calls','projects','applications','notifications'];
    setOpenTabs(tabs=>{
      const pinned=opsNow?'overview':'home';
      const filtered=tabs.filter(tab=>valid.includes(tab.page));
      let updated=filtered.some(tab=>tab.page===pinned)?filtered:[{page:pinned,targetId:null},...filtered];
      if(!updated.some(tab=>tab.page===page))updated=[...updated,{page,targetId}];
      return updated.length===tabs.length&&updated.every((tab,index)=>tab.page===tabs[index]?.page&&tab.targetId===tabs[index]?.targetId)?tabs:updated;
    });
  },[data,operations,page,targetId]);
  function resetSession(){
    setData(null);setEditor(null);setSecret(null);setDetail(null);setPurposeId('personal');setOperations(false);setPaletteOpen(false);setMenuOpen(false);setOpenTabs([]);setPage('home');setTargetId(null);setMessage('');
    setPending(previous=>{previous?.resolve(null);return null;});
  }
  async function refresh(isCurrent:()=>boolean=()=>true){
    try{const snapshot=await loadWorkspace();if(!isCurrent())return false;setData(snapshot);if(!data&&snapshot.actor.roles.includes('operator')){setOperations(true);setPage('overview');}return true;}
    catch(error){
      if(!isCurrent())return false;
      if(error instanceof ApiError&&(error.status===401||error.status===403)){
        const wasSignedIn=!!data;resetSession();
        if(wasSignedIn||error.status===403)setMessage(error.message);
        return false;
      }
      setMessage(error instanceof Error?error.message:'读取失败');return false;
    }
  }
  useEffect(()=>{let current=true;void (async()=>{try{const status=await api<{required:boolean;tokenRequired:boolean}>('/api/v1/auth/bootstrap');if(!current)return;setSetup(status.required);setSetupTokenRequired(status.tokenRequired);if(!status.required)await refresh(()=>current);}catch(error){if(current)setMessage(error instanceof Error?error.message:'控制面未连接');}finally{if(current)setLoading(false);}})();return()=>{current=false;};},[]);
  async function apply(command:PlatformCommand){
    try{const result=await executeCommand(command);await refresh();
      if(result.result&&typeof result.result==='object'&&'secret'in result.result){const issued=result.result as {secret:string;key?:{id?:string}};setSecret({value:String(issued.secret),keyId:issued.key?.id??null});}
      if(command.type==='retention.run'){
        const outcome=result.result as {removed:RetentionCounts};setMessage(`清理已完成：移除 ${retentionTotal(outcome.removed)} 条运行辅助记录，业务凭证与资金保留。`);
      }else if(command.type==='settings.retention')setMessage('保留策略已保存。实际执行方式和最近结果可在下方查看。');
      else if(command.type==='settings.update')setMessage('企业设置已保存。');
      else if(command.type==='keys.status'){
        const outcome=result.result as {changedCount:number;skippedCount:number};
        setMessage(`批量${command.payload.status==='revoked'?'吊销':'停用'}已完成：变更 ${outcome.changedCount} 把，跳过 ${outcome.skippedCount} 把。`);
      }else setMessage(`${actions[command.type]??'操作'}已完成`);return result.result;
    }catch(error){await refresh();setMessage(error instanceof Error?error.message:'操作失败');throw error;}
  }
  async function run(type:string,payload:Record<string,unknown>,confirm=true):Promise<unknown|null>{
    const command:PlatformCommand={type,payload,idempotencyKey:crypto.randomUUID()};
    if(!confirm)return apply(command);
    let preview:Preview;
    try{preview=await previewCommand(command);}catch(error){await refresh();throw error;}
    return new Promise((resolve,reject)=>setPending({command,preview,resolve,reject}));
  }
  async function confirm(){
    if(!pending)return;setBusy(true);
    try{const result=await apply({...pending.command,previewToken:pending.preview.previewToken});pending.resolve(result);setPending(null);}
    catch(error){pending.reject(error);setPending(null);setMessage(error instanceof Error?error.message:'操作失败');await refresh();}
    finally{setBusy(false);}
  }
  const action=(work:()=>Promise<unknown>)=>void work().catch(error=>setMessage(error instanceof Error?error.message:'操作失败'));
  if(loading)return <div className="loading-state">正在连接企业工作空间…</div>;
  if(!data)return <><ReviewBanner/><DesignSwitch mode={uiMode} onChange={setUiMode} className="login-design-switch"/><Login setup={setup} tokenRequired={setupTokenRequired} message={message} modern={desk} onInitialized={()=>{setSetup(false);setSetupTokenRequired(false);}} onDone={async()=>{setSetup(false);setMessage('');await refresh();}}/></>;
  const d=data,admin=d.actor.roles.includes('operator'),isOps=operations&&admin,edit=makeEditors(d,run,setEditor);
  const navigation=isOps?['overview','onboarding','approvals','projects','applications']:['home','online','quota','approvals'];
  const secondary=isOps?['catalog','models','members','keys','monitoring','safety','calls','reviews','settings']:['keys','calls','projects',...(d.applications.length?['applications']:[])];
  const navLabel=(item:string)=>!isOps&&!admin&&!d.projects.some(p=>p.managerId===d.actor.id)&&item==='approvals'?'我的申请':labels[item];
  const navItem=(item:string)=><button key={item} className={`nav-link ${page===item?'active':''}`} aria-current={page===item?'page':undefined} onClick={()=>navigate(item)}>{navLabel(item)}</button>;
  const secondaryLabel=isOps?'配置与排查':'工具与协作';
  const primaryEntries:NavEntry[]=navigation.map(id=>({id,label:navLabel(id)}));
  const secondaryEntries:NavEntry[]=secondary.map(id=>({id,label:labels[id]}));
  const pinnedPage=isOps?'overview':'home';
  const paletteItems:PaletteItem[]=[...navigation.map(id=>({id,label:navLabel(id),group:isOps?'运营空间':'个人空间',icon:navIcon(id)})),...secondary.map(id=>({id,label:labels[id],group:secondaryLabel,icon:navIcon(id)})),{id:'notifications',label:labels.notifications,group:'工具',icon:'bell'}];
  const unread=d.notifications.filter(n=>!n.readAt).length;
  /* Left-menu attention badges: only counts the current actor can act on. */
  const pendingApprovals=d.approvals.filter(a=>a.status==='pending'&&responsible(d,a)).length;
  const stalledApprovals=d.approvals.filter(a=>['failed','approved'].includes(a.status)&&responsible(d,a)).length;
  const navBadges:Record<string,number>={approvals:pendingApprovals+stalledApprovals,reviews:d.pendingReviewCount??0};
  const spaceLabel=isOps?'运营空间':'个人空间';
  const logout=()=>action(async()=>{await api('/api/v1/auth/logout',{});resetSession();});
  const activateTab=(tab:OpenTab)=>{setPage(tab.page);setTargetId(tab.targetId);setMenuOpen(false);};
  const closeTab=(tabPage:string)=>{
    const index=openTabs.findIndex(tab=>tab.page===tabPage);
    if(index<0)return;
    const remaining=openTabs.filter(tab=>tab.page!==tabPage);
    setOpenTabs(remaining);
    if(tabPage===page){
      const fallback=remaining[Math.max(0,index-1)]??remaining[0];
      if(fallback){setPage(fallback.page);setTargetId(fallback.targetId);}
      else {setPage(pinnedPage);setTargetId(null);}
    }
  };
  const switchSpace=(nextOperations:boolean)=>{
    setMenuOpen(false);
    if(nextOperations===operations)return;
    setOperations(nextOperations);setOpenTabs([]);setPage(nextOperations?'overview':'home');setTargetId(null);
  };
  const changeUiMode=(value:UiDesign)=>{setPaletteOpen(false);setMenuOpen(false);setUiMode(value);};
  const today=new Date(),dateLabel=`${today.getFullYear()}.${String(today.getMonth()+1).padStart(2,'0')}.${String(today.getDate()).padStart(2,'0')} · ${today.toLocaleDateString('zh-CN',{weekday:'short'})}`;
  const selfRefreshing=['calls','reviews','monitoring','safety'].includes(page);
  const mountedTabs=!desk?[{page,targetId}]:openTabs.some(tab=>tab.page===page)?openTabs:[...openTabs,{page,targetId}];
  const confirmationTitle=pending?.command.type==='retention.run'?'核对本次清理范围':pending?.command.type==='settings.retention'?'核对保留策略':pending?.command.type==='settings.update'?'核对企业设置':pending?.command.type==='distribution.execute'?String(pending.preview.impact.title):pending?.command.type==='keys.status'?`核对批量${pending.command.payload.status==='revoked'?'吊销':'停用'}名单`:pending?actions[pending.command.type]??'确认本次操作':'';
  const confirmationLabel=pending?.command.type==='retention.run'?`确认清理 ${retentionTotal((pending.preview.impact.retention as RetentionReport).eligible)} 条`:pending?.command.type==='settings.retention'?'确认保存策略':pending?.command.type==='settings.update'?'确认保存设置':pending?.command.type==='keys.status'?`确认${pending.command.payload.status==='revoked'?'吊销':'停用'} ${Number(pending.preview.impact.changedCount)} 把`:pending?.command.type==='save.organization'?Number(pending.preview.impact.totalAmount)>0?'确认调整并发放':'确认调整':'确认执行';
  return <><ReviewBanner/><div className={`shell ${next?'shell-next':''} ${sidebar?'shell-sidebar':''}`}>
    {v4Shell?<>
      <V4TopBar actorName={d.actor.name} admin={admin} isOps={isOps} notificationsActive={page==='notifications'} unread={unread} mode={uiMode} onModeChange={changeUiMode} onNavigateHome={()=>navigate(isOps?'overview':'home')} onSwitchSpace={switchSpace} onSearch={()=>setPaletteOpen(true)} onNotifications={()=>navigate('notifications')} onLogout={logout} menuOpen={menuOpen} onMenu={()=>setMenuOpen(true)} menuButtonRef={menuButtonRef} covered={narrow&&menuOpen}/>
      <V4Sidebar workspaceName={d.settings.name} isOps={isOps} page={page} primary={primaryEntries} secondary={secondaryEntries} secondaryLabel={secondaryLabel} badges={navBadges} mode={uiMode} onModeChange={changeUiMode} onNavigate={navigate} open={menuOpen} onClose={closeMenu} drawer={narrow}/>
    </>
    :sidebar?<>
      <V3PlatformBar actorName={d.actor.name} admin={admin} isOps={isOps} page={page} unread={unread} mode={uiMode} onModeChange={changeUiMode} onNavigate={navigate} onSwitchSpace={switchSpace} onSearch={()=>setPaletteOpen(true)} onNotifications={()=>navigate('notifications')} onLogout={logout} menuOpen={menuOpen} onMenu={()=>setMenuOpen(true)} menuButtonRef={menuButtonRef} covered={narrow&&menuOpen}/>
      <V3Sidebar workspaceName={d.settings.name} isOps={isOps} page={page} primary={primaryEntries} secondary={secondaryEntries} secondaryLabel={secondaryLabel} mode={uiMode} onModeChange={changeUiMode} onNavigate={navigate} open={menuOpen} onClose={closeMenu} drawer={narrow}/>
    </>
    :next?<V2Header actorName={d.actor.name} workspaceName={d.settings.name} admin={admin} isOps={isOps} page={page} primary={navigation} secondary={secondary} secondaryLabel={secondaryLabel} labels={labels} unread={unread} mode={uiMode} onModeChange={changeUiMode} onNavigate={navigate} onSwitchSpace={switchSpace} onSearch={()=>setPaletteOpen(true)} onNotifications={()=>navigate('notifications')} onLogout={logout}/>
    :<aside className="rail"><div className="brand"><div className="mark">T</div><div><b>Signal Atlas</b><span>企业 AI 资源运营</span></div></div>
    {admin&&<div className="mode-switch"><button className={isOps?'selected':''} onClick={()=>switchSpace(true)}>运营空间</button><button className={!isOps?'selected':''} onClick={()=>switchSpace(false)}>个人空间</button></div>}
    <nav aria-label="主导航">{navigation.map(navItem)}<details className="nav-group" key={isOps?'ops':'personal'} open={secondary.includes(page)||undefined}><summary>{isOps?'配置与排查':'工具与协作'}</summary><div>{secondary.map(navItem)}</div></details></nav>
  </aside>}
    <main className="main" inert={docked&&menuOpen?true:undefined}>
      {v4Shell?<V4PageTabs tabs={openTabs} page={page} labelFor={navLabel} pinnedPage={pinnedPage} onActivate={activateTab} onClose={closeTab}/>:sidebar&&<V3TabBar tabs={openTabs} page={page} labelFor={navLabel} pinnedPage={pinnedPage} onActivate={activateTab} onClose={closeTab}/>}
      {!desk&&<div className="top"><span>{d.settings.name} / {isOps?'运营空间':'个人空间'}</span><div className="inline-actions"><DesignSwitch mode={uiMode} onChange={changeUiMode}/><button onClick={()=>navigate('notifications')}>通知 {unread||''}</button><span>{d.actor.name}</span><button onClick={logout}>退出登录</button></div></div>}
      <div className={`page ${next?'v2-page':''}`}>
        {next&&<div className="v2-scope" aria-hidden="true"><span>{isOps?'运营空间':'个人空间'}</span><span className="v2-scope-sep">/</span><b>{labels[page]}</b><span className="v2-scope-date">{dateLabel}</span></div>}
        {v4Shell&&<div className="page-context" aria-hidden="true"><span>{spaceLabel}</span><span className="page-context-date">{dateLabel}</span></div>}
        <section className="heading"><div><span className="eyebrow">{isOps?'OPERATIONS':'PERSONAL WORKSPACE'}</span><h1>{navLabel(page)}</h1>{v4Shell&&ledes[page]&&<p className="page-lede">{ledes[page]}</p>}</div>{!selfRefreshing&&<button className="ghost" onClick={()=>void refresh()}>刷新数据</button>}</section>{message&&<div className="notice" role="status">{message}</div>}
        {page!=='monitoring'&&d.callDataQuality==='collection_failed'&&<div className="notice warning" role="alert">调用统计暂不可用，费用待核对数量未知。{isOps?<button className="link-button" onClick={()=>navigate('monitoring')}>检查监控采集 →</button>:'请联系企业运营检查采集。'}</div>}
        {mountedTabs.map(tab=><div key={tab.page} hidden={tab.page!==page} className={desk?'v2-page-enter':''}><WorkspacePages data={d} page={tab.page} targetId={tab.targetId} active={tab.page===page} isOps={isOps} edit={edit} purposeId={purposeId} setPurpose={setPurposeId} setPage={navigate} run={run} refresh={refresh} action={action} detail={(title,content)=>setDetail({title,content})}/></div>)}
      </div>
    </main>
    {docked&&<div className={`${v4Shell?'v4-backdrop':'v3-backdrop'} ${menuOpen?'open':''}`} onClick={closeMenu} aria-hidden="true"/>}
    <AlertWatcher enabled={isOps&&['overview','monitoring'].includes(page)&&!editor&&!pending&&!detail&&!secret} run={run} onOpen={()=>{setOperations(true);setPage('monitoring');}}/>
    {editor&&<EditorFlow key={editor.title} editor={editor} data={d} run={run} refresh={refresh} onClose={()=>setEditor(null)}/>}
    {pending&&<Modal title={confirmationTitle} onClose={()=>{if(!busy){pending.resolve(null);setPending(null);}}} footer={<><button className="ghost" disabled={busy} onClick={()=>{pending.resolve(null);setPending(null);}}>返回修改</button><button className="primary" disabled={busy} onClick={()=>void confirm()}>{busy?'正在执行…':confirmationLabel}</button></>}><Impact pending={pending} data={d}/></Modal>}
    {secret&&<Modal title="请保存完整密钥" onClose={()=>setSecret(null)} footer={<button className="primary" onClick={()=>{const keyId=secret.keyId;setSecret(null);if(keyId)setDetail({title:'编程工具接入',content:<KeyDetails keyId={keyId} data={d} guideOnly/>});}}>我已保存，查看接入指引</button>}><div className="notice warning">仅本次显示，关闭后无法再次读取。请保存到受控的凭据管理工具。</div><textarea className="secret-value" readOnly value={secret.value} aria-label="完整密钥" onFocus={event=>event.target.select()}/></Modal>}
    {detail&&<Modal title={detail.title} onClose={()=>setDetail(null)}>{typeof detail.content==='function'?detail.content(d,edit):detail.content}</Modal>}
    {desk&&<CommandPalette open={paletteOpen} items={paletteItems} onClose={()=>setPaletteOpen(false)} onSelect={navigate}/>}
  </div></>;
}

function ReviewBanner(){return import.meta.env.VITE_REVIEW_MODE==='true'?<div className="review-banner" role="note">人工审查模式 · 本地模型替身 · {import.meta.env.VITE_REVIEW_STORAGE==='postgres'?'审查数据会保留，重启后可继续':'业务数据在服务重启后清空'}</div>:null;}

function Impact({pending,data}:{pending:Pending;data:PlatformSnapshot}){
  const p=pending.command.payload,impact=pending.preview.impact;
  if(pending.command.type==='guardrail.update'){
    const before=impact.before as import('@ai-gateway/contracts').GuardrailPolicy,after=impact.after as import('@ai-gateway/contracts').GuardrailPolicy,modes={off:'关闭',observe:'仅记录',block:'拦截'};const range=(p:typeof after)=>p.modelIds===null?'全部模型（含新增）':p.modelIds.map(id=>data.definitions.find(d=>d.modelId===id)?.name??id).join('、');
    return <><dl className="detail-list"><div><dt>处理模式</dt><dd>{modes[before.mode]} → {modes[after.mode]}</dd></div><div><dt>模型范围</dt><dd>{range(before)} → {range(after)}</dd></div><div><dt>规则数量</dt><dd>{before.presets.length+before.words.length} → {after.presets.length+after.words.length}</dd></div><div><dt>策略版本</dt><dd>{before.version} → {after.version}</dd></div></dl><p className="notice warning">{after.mode==='off'?'保存后停止对新请求检查输入。':after.mode==='observe'?'命中只记录，内容仍会发送给模型。':'命中后拒绝发送，不创建预占、不扣费。'}仅影响后续准入，历史费用和已准入调用保留。</p><p className="request-reason">变更原因：{String(p.reason)}</p></>;
  }
  if(pending.command.type==='settings.update'){
    const changes=pending.preview.impact.settingsChanges as {label:string;before:string;after:string}[];
    return <><dl className="detail-list">{changes.map(change=><div key={change.label}><dt>{change.label}</dt><dd>{change.before} → {change.after}</dd></div>)}</dl><p className="notice">{!!p.limits?'变更影响后续新请求；已预占的请求继续按原依据结算。':'personalDefaultPoolId'in p||'projectDefaultPoolId'in p?'默认池仅影响后续新建或审批时的预填，不迁移已有权益，不发放资金。':'本次仅修改工作区的展示名称。'}现有组织、账号和历史记录保留。</p><p className="secondary">以上为服务端核对的当前值。如有其他运营更新了配置，需要重新预览并核对后再保存。</p></>;
  }
  if(impact.retention){const report=impact.retention as RetentionReport;return <><p>本次将清理 <strong>{retentionTotal(report.eligible)} 条</strong>运行辅助记录。</p><RetentionCountsView counts={report.eligible}/><p>通知与告警截至 {date(report.cutoff)} 以前；过期会话截至 {date(report.checkedAt)}。</p><p className="notice warning">确认后永久移除上述通知、已恢复告警和过期会话记录。未读通知、未完成事项及活跃告警继续保留。</p><p>账本、调用元数据、审批、开通记录、操作审计和当前登录均保留。清理不会发放、回收或退还额度。</p><p className="request-reason">清理原因：{String(p.reason)}</p></>;}
  if(impact.retentionPolicy){const policy=impact.retentionPolicy as {before:{days:number;automatic:boolean};after:{days:number;automatic:boolean};eligible:RetentionCounts};return <><dl className="detail-list"><div><dt>通知与告警期限</dt><dd>{policy.before.days} 天 → {policy.after.days} 天</dd></div><div><dt>执行方式</dt><dd>{policy.before.automatic?'每日自动清理':'按需手动'} → {policy.after.automatic?'每日自动清理':'按需手动'}</dd></div></dl><h3>按新策略当前可清理的记录</h3><RetentionCountsView counts={policy.eligible}/><p className="notice">{policy.after.automatic?'确认后保存策略。下一次后台维护可能立即清理符合条件的记录，之后每天检查一次。':'确认仅保存策略；本次不清理记录。需要清理时另行检查并确认。'}</p><p>未读通知、未完成事项和活跃告警继续保留。账本、调用元数据、业务记录及操作审计继续保留。</p><p className="request-reason">调整原因：{String(p.reason)}</p></>;}
  if(Array.isArray(impact.keyChanges))return <>
    <p>本次拟变更 <strong>{Number(impact.changedCount)} 把</strong>，跳过 {Number(impact.skippedCount)} 把。确认前未改变任何密钥。</p>
    <div className={`notice ${p.status==='revoked'?'warning':''}`}>{p.status==='revoked'?'吊销后无法恢复。相关工具需要重新签发并更换密钥后才能接入。':p.status==='disabled'?'停用后，使用这些密钥的工具将无法发起新调用；需要时可逐把恢复。':'启用仅恢复密钥状态，仍需满足用途权益、模型、有效期和额度要求。'}用途额度不变，已准入请求按原预占结算。</div>
    <ul className="key-change-list" aria-label="本次处理密钥">{(impact.keyChanges as {id:string;name:string;masked:string;ownerName:string;organizationName:string;purpose:string;subjectName:string;before:string;after:string;changed:boolean;skipReason:string}[]).map(k=><li key={k.id}>
      <div className="key-change-head"><strong>{k.name}</strong><code>{k.masked}</code></div><p>{k.ownerName} · {k.organizationName}</p><p>{({personal:'个人',project:'项目',application:'应用'} as Record<string,string>)[k.purpose]} · {k.subjectName}</p><div className="key-change-head"><span><Status value={k.before}/> → <Status value={k.after}/></span><span>{k.changed?'本次变更':`跳过：${k.skipReason}`}</span></div>
    </li>)}</ul><p className="request-reason">处理原因：{String(p.reason)}</p><p className="secondary">名单、权限或其他配置发生变化时，需要重新预览。任一对象无权处理或不存在时，整批不会生效。</p>
  </>;
  if(impact.entitlementMigration){
    const migration=impact.entitlementMigration as EntitlementMigrationPreview;
    const modelName=(id:string)=>data.definitions.find(definition=>definition.modelId===id)?.name??id;
    const describeLimits=(value:{mode:string;rpm?:number;tpm?:number;concurrency?:number;maxOutputTokens?:number})=>value.mode==='inherit'?'继承默认保护':value.mode==='none'?'本级不额外限制':[['RPM',value.rpm],['TPM',value.tpm],['并发',value.concurrency],['单次输出',value.maxOutputTokens]].filter(([,v])=>v!==undefined).map(([label,v])=>`${label} ${String(v)}`).join(' · ')||'未设置数值';
    const modelDiff=(added:string[],removed:string[])=>[added.length?`新增 ${added.map(modelName).join('、')}`:'',removed.length?`关闭 ${removed.map(modelName).join('、')}`:''].filter(Boolean).join('；')||'无变化';
    return <>
      <p>方案 <strong>{migration.planName}</strong> 当前 v{migration.planVersion} · {migration.cadence==='monthly'?'月度发放':'一次性'}。本次变更 {migration.changedCount} 项，跳过 {migration.skippedCount} 项，不适用 {migration.inapplicableCount} 项。</p>
      <div className="notice">不补发额度：不补差、不发新额度、不重复发本月额度。已发批次余额、累计发放、到期日与资金来源保持不变；月度后续应发周期按目标快照执行。</div>
      <Table headers={['人员','原版本 → 目标','模型范围变化','金额（已发不变 / 后续标准）','限制变化','状态 / 原因']} rows={migration.rows.map(row=>[row.memberName,`v${row.fromVersion} → v${row.toVersion}`,modelDiff(row.modelsAdded,row.modelsRemoved),`${money(row.amountBefore)} / ${money(row.amountAfter)}`,`${describeLimits(row.limitsBefore)} → ${describeLimits(row.limitsAfter)}`,<>{row.status==='change'?'变更':row.status==='skip'?'跳过':'不适用'}<small className="cell-help">{row.reason}</small>{row.status==='change'&&row.affectedKeyIds.length?<small className="cell-help">影响 {row.affectedKeyIds.length} 把密钥</small>:null}</>])}/>
      <p className="request-reason">迁移依据：{migration.reason}</p>
      <p className="secondary">确认后整批事务更新，并逐人写入审计；方案、人员或职责变化后需要重新预览。已准入请求继续按原路由、价格与资金批次结算。</p>
    </>;
  }
  if(pending.command.type==='key.issue')return <><p>即将为 <strong>{p.purpose==='application'?data.applications.find(a=>a.id===p.applicationId)?.name:p.purpose==='project'?data.projects.find(v=>v.id===p.projectId)?.name:data.actor.name}</strong> 签发一把密钥。</p><dl className="detail-list"><div><dt>密钥名称</dt><dd>{String(p.name)}</dd></div><div><dt>扣费用途</dt><dd>{p.purpose==='application'?'独立应用':p.purpose==='project'?'项目成员':'个人日常办公'}</dd></div><div><dt>到期时间</dt><dd>{date(String(p.expiresAt))}</dd></div></dl><p className="notice warning">完整值只在签发后展示一次，请保存到受控的凭据管理工具。该密钥使用当前用途的额度和限制。</p></>;
  const executionDescription=(input:unknown)=>{const value=(input??{}) as {planId?:string;managerId?:string;range?:{poolId:string;mode:string;definitionIds:string[]};sourceBatchId?:string};return [value.planId?`开通方案：${data.plans.find(plan=>plan.id===value.planId)?.name??value.planId}`:'',value.managerId?`经理：${data.members.find(m=>m.id===value.managerId)?.name??value.managerId}`:'',value.range?`模型池：${data.pools.find(pool=>pool.id===value.range?.poolId)?.name??value.range.poolId} · ${value.range.mode==='follow'?'跟随池':'指定模型'}`:'',value.sourceBatchId?`预算批次：${value.sourceBatchId}`:''].filter(Boolean).join('；')||'无额外参数';};
  if(pending.command.type==='distribution.execute'&&Array.isArray(impact.members))return <><p>方案：<strong>{String(impact.planName??'已有方案额度追加')}</strong></p><div className="project-summary"><div>本次纳入<strong>{Number(impact.grantCount)} 人</strong></div><div>新增额度合计<strong>{money(Number(impact.totalAmount))}</strong></div></div><Table headers={['人员','本次结果','新增金额','到期时间','说明']} rows={(impact.members as {name:string;included:boolean;amount:number;expiresAt:string;reason:string}[]).map(m=>[m.name,m.included?'纳入本次':'跳过',money(m.amount),m.included?date(m.expiresAt):'—',m.reason||'—'])}/><p className="secondary">请核对人员、金额和到期日。确认后执行；跳过的人员不会新增额度。</p></>;
  return <><p>确认对象、范围、金额和期限后执行。此预览未改变业务数据。</p><dl className="detail-list">
    {!!p.name&&<div><dt>名称</dt><dd>{String(p.name)}</dd></div>}{p.amount!==undefined&&<div><dt>金额</dt><dd>{money(Number(p.amount))}</dd></div>}{!!p.expiresAt&&<div><dt>到期时间</dt><dd>{date(String(p.expiresAt))}</dd></div>}
    {!!p.projectId&&<div><dt>项目</dt><dd>{data.projects.find(project=>project.id===p.projectId)?.name??String(p.projectId)}</dd></div>}{!!p.memberId&&<div><dt>成员</dt><dd>{data.members.find(member=>member.id===p.memberId)?.name}</dd></div>}
    {!!p.planId&&<div><dt>开通方案</dt><dd>{data.plans.find(plan=>plan.id===p.planId)?.name}</dd></div>}
    {!!p.managerId&&<div><dt>项目经理</dt><dd>{data.members.find(member=>member.id===p.managerId)?.name??String(p.managerId)}</dd></div>}
    {!!p.ownerId&&<div><dt>应用负责人</dt><dd>{data.members.find(member=>member.id===p.ownerId)?.name??String(p.ownerId)}</dd></div>}
    {!!p.range&&<div><dt>模型范围</dt><dd>{data.pools.find(pool=>pool.id===(p.range as {poolId:string}).poolId)?.name??'所选模型池'} · {(p.range as {mode:string}).mode==='follow'?'跟随池内已开放模型':`仅指定：${(p.range as {definitionIds:string[]}).definitionIds.map(id=>data.definitions.find(definition=>definition.id===id)?.name??id).join('、')}`}</dd></div>}
    {!!p.limits&&<div><dt>本级使用保护</dt><dd>{(p.limits as {mode:string}).mode==='inherit'?'继承企业默认':(p.limits as {mode:string}).mode==='none'?'本级不额外限制，其他适用边界继续生效':Object.entries(p.limits as Record<string,unknown>).filter(([key])=>key!=='mode').map(([key,value])=>`${({rpm:'RPM',tpm:'TPM',concurrency:'并发',maxOutputTokens:'单次输出'} as Record<string,string>)[key]??key} ${String(value)}`).join(' · ')}</dd></div>}
    {impact.grantCount!==undefined&&<><div><dt>拟发放 / 跳过</dt><dd>{String(impact.grantCount)} / {String(impact.excludedCount)}</dd></div><div><dt>本次拟发放总额</dt><dd>{money(Number(impact.totalAmount))}</dd></div></>}
    {!!p.reason&&<div><dt>处理说明</dt><dd>{String(p.reason)}</dd></div>}
    {impact.originalHold!==undefined&&<><div><dt>原预占</dt><dd>{money(Number(impact.originalHold))}</dd></div><div><dt>核对后实际费用</dt><dd>{money(Number(impact.amount))}</dd></div><div><dt>原批次余额变化</dt><dd>{Number(impact.balanceChange)>=0?'释放':'补扣'} {money(Math.abs(Number(impact.balanceChange)))}</dd></div></>}
  </dl>{Array.isArray(impact.members)&&<><p className="secondary">{String(impact.scopeDescription??'本次名单')} · 方案 {String(impact.planName??'')}</p><Table headers={['成员','本次结果','金额','到期日','说明']} rows={(impact.members as {id:string;name:string;included:boolean;amount:number;expiresAt:string;reason:string}[]).map(m=>[m.name,m.included?'纳入':'跳过 / 排除',money(m.amount),m.included?date(m.expiresAt):'—',m.reason||'—'])}/></>}
    {!!impact.organizationChange&&<OrganizationImpact change={impact.organizationChange as OrganizationChangeImpact}/>}
    {Array.isArray(impact.memberChanges)&&<Table headers={['成员','登录账号','变更','组织','状态']} rows={(impact.memberChanges as {id:string;name:string;directoryId:string;kind:string;organizationId:string;active:boolean}[]).map(m=>[m.name,m.directoryId,m.kind,data.organizations.find(o=>o.id===m.organizationId)?.name,m.active?'启用':'停用'])}/>}
    {Array.isArray(impact.automaticGrants)&&<><p>命中结果 {impact.automaticGrants.length} 条 · 本次拟发放总额 {money(Number(impact.totalAmount??0))}</p>{!!impact.ruleApplication&&<p className="secondary">{String(impact.ruleApplication)}</p>}<Table headers={['成员','方案 / 版本','命中规则','结果 / 原因','金额','预计到期']} rows={(impact.automaticGrants as {memberName:string;planName:string;planVersion:number;conditions:{name:string}[];status:string;reason:string;amount:number;expiresAt:string}[]).map(m=>[m.memberName,`${m.planName} · v${m.planVersion}`,m.conditions.map(r=>r.name).join('、'),`${m.status==='granted'?'可开通':m.status==='failed'?'失败':'跳过'}${m.reason?` · ${m.reason}`:''}`,money(m.amount),m.status==='granted'?date(m.expiresAt):'—'])}/></>}
    {Array.isArray(impact.stoppedFutureGrants)&&impact.stoppedFutureGrants.length>0&&<div className="notice warning">停止未来周期发放：{(impact.stoppedFutureGrants as {memberId:string;planName:string}[]).map(e=>`${data.members.find(m=>m.id===e.memberId)?.name??e.memberId} / ${e.planName}`).join('、')}。当前资金批次保留原期限。</div>}
    {Array.isArray(impact.resumedFutureGrants)&&impact.resumedFutureGrants.length>0&&<div className="notice">恢复未来周期发放：{(impact.resumedFutureGrants as {memberId:string;planName:string}[]).map(e=>`${data.members.find(m=>m.id===e.memberId)?.name??e.memberId} / ${e.planName}`).join('、')}。同一周期仍只发放一次。</div>}
    {!!impact.approvalBefore&&!!impact.approvalAfter&&<Table headers={['修正项','原批准值','修正后']} rows={(()=>{const before=impact.approvalBefore as {approvedAmount:number;approvedExpiresAt:string;execution:unknown;approverId:string},after=impact.approvalAfter as typeof before;return [['批准金额',money(before.approvedAmount),money(after.approvedAmount)],['批准期限',date(before.approvedExpiresAt),date(after.approvedExpiresAt)],['执行方案',executionDescription(before.execution),executionDescription(after.execution)],['批准人',data.members.find(m=>m.id===before.approverId)?.name??before.approverId,data.members.find(m=>m.id===after.approverId)?.name??after.approverId]];})()}/>}
    {!!impact.projectClosing&&(()=>{const closing=impact.projectClosing as {name:string;memberCount:number;keyCount:number;memberAmount:number;budgetAmount:number;totalAmount:number};return <><h3>结束项目：{closing.name}</h3><p>影响 {closing.memberCount} 名项目成员、{closing.keyCount} 把项目密钥。结束后不再接受新调用或分配，不能重新启用项目。</p><Table headers={['预览时未使用余额','金额']} rows={[["项目未分配预算",money(closing.budgetAmount)],["成员未使用余额",money(closing.memberAmount)],["合计拟回收",money(closing.totalAmount)]]}/><p className="notice warning">金额按执行时实际余额回收至结束记录，不转入其他用途。已预占资金单独保留，后续结算或核对释放的金额也进入回收记录。原批次和消费历史保留。</p></>;})()}
    {!!impact.projectMemberChanges&&(()=>{const changes=impact.projectMemberChanges as {projectName:string;added:string[];removed:string[]};return <><h3>{changes.projectName} · 成员关系变更</h3><p>添加：{changes.added.join('、')||'无'}；移出：{changes.removed.join('、')||'无'}。</p><p className="secondary">添加不发放额度。移出后阻止该用途新调用，原批次与历史保留；重新加入仍受原期限约束，结束项目时统一回收未使用余额。</p></>;})()}
    {Array.isArray(p.mappings)&&<Table headers={['模型','上游标识','输入 / 输出 / 缓存输入价格（元/百万 Token）']} rows={(p.mappings as {definitionId:string;upstreamModel:string;inputPrice:number|null;outputPrice:number|null;cachedInputPrice:number|null}[]).map(m=>[data.definitions.find(definition=>definition.id===m.definitionId)?.name??m.definitionId,m.upstreamModel,[m.inputPrice,m.outputPrice,m.cachedInputPrice].map(value=>value===null||value===undefined?'未知':String(value)).join(' / ')])}/>}
    {Array.isArray(impact.modelChanges)&&<Table headers={['模型','当前状态与来源','确认后状态与来源']} rows={(impact.modelChanges as {name:string;before:string;after:string}[]).map(change=>[change.name,change.before,change.after])}/>}
    {!!impact.related&&<p className="secondary">关联对象：{Object.entries(impact.related as Record<string,unknown[]>).map(([key,value])=>`${({plans:'方案',entitlements:'人员权益',projects:'项目',applications:'应用',members:'成员',children:'下级组织'} as Record<string,string>)[key]??key} ${value.length}`).join(' · ')}</p>}
    <p className="secondary">历史调用与审计保留；资金与模型范围分别追溯。其他配置变化后需要重新预览。</p></>;
}

function Login({setup,tokenRequired,message,modern,onInitialized,onDone}:{setup:boolean;tokenRequired:boolean;message:string;modern:boolean;onInitialized:()=>void;onDone:()=>Promise<void>}){
  const [directoryId,setDirectoryId]=useState(''),[name,setName]=useState(''),[password,setPassword]=useState(''),[bootstrapToken,setBootstrapToken]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function submit(event:FormEvent){
    event.preventDefault();setBusy(true);setError('');
    try{if(setup){await api('/api/v1/auth/setup',{directoryId,name,password,bootstrapToken});setBootstrapToken('');onInitialized();}await api('/api/v1/auth/login',{directoryId,password});setPassword('');await onDone();}
    catch(error){setError(error instanceof Error?error.message:'登录失败');}finally{setBusy(false);}
  }
  return <div className="login-shell"><section className="login-intro"><div className="brand">{modern?<SignalMark/>:<div className="mark">T</div>}<b>Signal Atlas</b></div><span className="eyebrow">ENTERPRISE AI OPERATIONS</span><h1>让每份 AI 资源<br/>都有清楚的去向。</h1><p>开通人员、治理模型、分配项目额度，<br/>在同一条业务链路中追溯每次调用。</p></section><section className="login-panel"><span className="eyebrow">{setup?'INITIAL SETUP':'WELCOME BACK'}</span><h2>{setup?'初始化企业管理员':'登录企业工作空间'}</h2><form onSubmit={event=>void submit(event)}>
    {setup&&tokenRequired&&<label>安装口令<PasswordInput id="setup-bootstrap-token" autoComplete="off" required value={bootstrapToken} onChange={setBootstrapToken}/><small>由安装负责人提供，仅用于首次创建管理员。</small></label>}{setup&&<label>管理员姓名<input required value={name} onChange={event=>setName(event.target.value)}/></label>}<label>登录账号<input required autoComplete="username" value={directoryId} onChange={event=>setDirectoryId(event.target.value)}/><small>{setup?'用于首次登录，之后也是你的登录名。':'由运营创建，不能与他人重复。'}</small></label><label>密码<PasswordInput id="login-password" required minLength={setup?12:undefined} autoComplete={setup?'new-password':'current-password'} value={password} onChange={setPassword}/></label>
    {(error||message)&&<div className="notice danger" role="alert">{error||message}</div>}<button className="primary" disabled={busy}>{busy?'正在处理…':setup?'创建管理员并登录':'登录'}</button>
  </form><p className="secondary">{setup?'首次初始化只能执行一次，密码至少 12 位。':'成员账号由运营创建，停用或到期账号不能登录。'}</p></section></div>;
}
