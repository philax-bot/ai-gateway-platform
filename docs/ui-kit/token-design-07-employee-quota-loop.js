
(() => {
"use strict";
const STORE="signal-atlas-model-access-v4", TODAY="2026-10-16";
const roleNames={employee:"员工 · 陈默",manager:"项目经理 · 赵宁",ops:"运营 · 林晓"};
const people={chen:"陈默",zhao:"赵宁",lin:"林晓"};
const catalog=["Qwen 2.5","DeepSeek V3","GLM 4.6（演示）"];
const copy=x=>JSON.parse(JSON.stringify(x));
const labels={pending:"待审批",approved:"已生效",rejected:"已驳回"};
const kindNames={general:"个人通用额度",member:"项目成员额度",budget:"项目总额度",projectCreate:"创建项目"};
const money=n=>"¥ "+(n/100).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const time=()=>new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date());
const fresh=()=>({
 version:4,role:"employee",nav:"home",selected:{chen:"general",zhao:"q4"},project:"q4",requestId:"",tab:"todo",logFilter:"all",seq:100,
 defaults:{personal:"office",project:"coding"},
 pools:{office:{name:"日常办公池",models:["Qwen 2.5"],staged:[]},coding:{name:"研发编程池",models:["Qwen 2.5","DeepSeek V3"],staged:["GLM 4.6（演示）"]},support:{name:"客服模型池",models:["Qwen 2.5"],staged:[]}},
 plans:[{id:"office-plan",name:"标准办公方案",pool:"office",mode:"follow",allowed:[],amount:30000,cycle:"monthly",expiry:"2026-12-31"},{id:"coding-plan",name:"研发试用方案",pool:"coding",mode:"subset",allowed:["Qwen 2.5"],amount:10000,cycle:"once",expiry:"2026-12-31"}],
 entitlements:[{id:"E-CHEN",owner:"chen",planId:"office-plan",name:"标准办公方案",pool:"office",mode:"follow",allowed:[],expiry:"2026-12-31"},{id:"E-ZHAO",owner:"zhao",planId:"coding-plan",name:"研发试用方案",pool:"coding",mode:"subset",allowed:["Qwen 2.5"],expiry:"2026-12-31"}],
 accessDrafts:{},poolId:"coding",memberId:"chen",audit:[],
 projects:[
  {id:"q4",name:"Q4 研发项目",manager:"zhao",members:["chen","zhao"],pool:"coding",mode:"follow",allowed:[],grants:[{id:"Q4-01",amount:500000,expiry:"2026-12-31",source:"运营首批发放"}]},
  {id:"cs",name:"智能客服项目",manager:"zhao",members:["chen","zhao"],pool:"support",mode:"subset",allowed:["Qwen 2.5"],grants:[{id:"CS-01",amount:300000,expiry:"2026-11-30",source:"运营首批发放"}]}
 ],
 wallets:{
  chen:{general:[{id:"G-CHEN-01",entitlementId:"E-CHEN",amount:30000,spent:0,expiry:"2026-11-30",pool:"office",source:"员工月度方案"}],q4:[],cs:[{id:"W-CS-CHEN",amount:50000,spent:0,expiry:"2026-11-30",pool:"support",grantId:"CS-01",source:"经理直接分配"}]},
  zhao:{general:[{id:"G-ZHAO-01",entitlementId:"E-ZHAO",amount:10000,spent:0,expiry:"2026-11-30",pool:"coding",source:"研发试用方案"}],q4:[{id:"W-Q4-ZHAO",amount:15000,spent:0,expiry:"2026-12-31",pool:"coding",grantId:"Q4-01",source:"运营分配"}],cs:[]}
 },
 requests:[],reviews:{},drafts:{},keys:[],logs:[],keyId:"",model:"",resultId:""
});
let s=fresh(),error="",notice="",prompt="",rejecting=false,resetPending=false;
try {
 const saved=JSON.parse(sessionStorage.getItem(STORE));
 if(saved?.version===4&&roleNames[saved.role]&&Array.isArray(saved.projects)&&saved.wallets?.chen&&saved.wallets?.zhao&&Array.isArray(saved.requests)&&saved.drafts&&saved.reviews&&saved.pools&&saved.entitlements&&saved.accessDrafts)s=saved;
} catch{}
initResources();
if(s.resourceDrafts.service?.check?.status==='checking')s.resourceDrafts.service.check={status:'untested'};
const actor=()=>s.role==="employee"?"chen":s.role==="manager"?"zhao":"lin";
const project=id=>s.projects.find(p=>p.id===id);
const scopeName=id=>id==="general"?"个人通用额度":project(id)?.name||id;
const scopeLabel=id=>id==="general"?"个人通用额度":scopeName(id)+" · 我的项目额度";
const current=()=>s.selected[actor()]||"general";
const scopes=()=>["general",...s.projects.filter(p=>p.members.includes(actor())).map(p=>p.id)];
const wallet=(id,user=actor())=>s.wallets[user]?.[id]||[];
const live=g=>g.expiry>=TODAY;
const balance=(id,user=actor())=>wallet(id,user).filter(live).reduce((n,g)=>n+g.amount-g.spent,0);
const request=()=>s.requests.find(r=>r.id===s.requestId);
const canManage=p=>!!p&&(s.role==="ops"||p.manager===actor());
const pending=(scope,owner=actor(),kind=scope==="general"?"general":"member")=>s.requests.find(r=>r.scope===scope&&r.owner===owner&&r.kind===kind&&r.status==="pending");
const reviewer=(kind,scope,owner)=>kind==="general"||kind==="budget"||project(scope)?.manager===owner?"lin":project(scope)?.manager;
const reviewerName=id=>people[id]+(id==="lin"?" · 运营":" · 项目经理");
const ownRequests=()=>s.requests.filter(r=>r.owner===actor());
const myTasks=()=>s.requests.filter(r=>r.reviewer===actor());
function save(){try{sessionStorage.setItem(STORE,JSON.stringify(s));}catch{}}
function cents(v){const t=String(v??"").trim();if(!/^\d{1,8}(\.\d{1,2})?$/.test(t))return null;const n=Math.round(Number(t)*100);return n>0&&Number.isSafeInteger(n)?n:null;}
function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v))&&new Date(v+"T00:00:00Z").toISOString().slice(0,10)===v&&v>=TODAY&&v<="2027-06-30";}
function remaining(p,g){return g.amount-p.members.reduce((n,u)=>n+wallet(p.id,u).filter(w=>w.grantId===g.id).reduce((a,w)=>a+w.amount,0),0);}
function grantOptions(p){return p.grants.filter(live).sort((a,b)=>a.expiry.localeCompare(b.expiry));}
function rights(user=actor()){return s.entitlements.filter(e=>e.owner===user&&live(e));}
function configuredRange(binding){const active=s.pools[binding?.pool]?.models||[];return binding?.mode==="subset"?active.filter(m=>binding.allowed.includes(m)):active;}
function rangeModels(binding){return configuredRange(binding).filter(m=>sourceReady(s.pools[binding.pool]?.sources?.[m],m));}
function poolIds(id){return [...new Set(id==="general"?rights().map(e=>e.pool):[project(id)?.pool])].filter(Boolean);}
function models(id){return id==="general"?[...new Set(rights().flatMap(rangeModels))]:rangeModels(project(id));}
function quotaSupports(w,scope,model){if(scope!=="general")return rangeModels(project(scope)).includes(model);const e=rights().find(e=>e.id===w.entitlementId);return !!e&&rangeModels(e).includes(model);}
function usageState(scope,model=""){
 const bindings=scope==="general"?rights():[project(scope)].filter(Boolean),available=models(scope);
 const grants=wallet(scope).filter(w=>live(w)&&(model?quotaSupports(w,scope,model):available.some(m=>quotaSupports(w,scope,m))));
 const amount=grants.reduce((n,w)=>n+Math.max(0,w.amount-w.spent),0);
 const canUse=grants.some(w=>w.amount-w.spent>=2);
 const base={available,grants,amount,canUse:false};
 if(!bindings.length)return {...base,code:"unopened",label:"未开通模型",title:"先开通个人 AI 使用权限",detail:s.entitlements.some(e=>e.owner===actor())?"原有模型授权已过期。提交使用需求，由运营确认新的开通方案。":"个人通用使用不需要加入项目。提交使用需求，由运营确认模型与额度。",action:"access",actionLabel:"申请开通模型与额度"};
 if(!available.length||(model&&!available.includes(model)))return {...base,code:"unavailable",label:"模型暂不可用",title:"当前模型范围暂不可用",detail:"模型可能已停用、移出范围或尚未开放，请由运营确认模型范围。追加额度不会恢复模型权限。",action:"models",actionLabel:"查看模型范围"};
 if(!grants.length)return {...base,code:"noquota",label:"无有效额度",title:"为当前用途申请额度",detail:model?"尚无有效且适用于这个模型的额度批次。其他方案的余额不能代替。":scope==="general"?"模型权限已开通，尚无适用的有效额度。": "已加入项目并继承模型范围，成员额度需由负责人分配。",action:"apply",actionLabel:"申请此用途额度"};
 if(!canUse)return {...base,code:"insufficient",label:"额度不足",title:"补充当前用途的适用额度",detail:amount>=2?"适用余额分散在多个批次，本地演示要求单批次覆盖 ¥ 0.02。请追加对应来源额度。":"有效批次的剩余额度不足以支持本次模拟调用，请追加对应来源额度。",action:"apply",actionLabel:"申请追加额度"};
 return {...base,code:"ready",canUse:true,label:"可使用",title:"开始使用 AI",detail:"在线处理工作，或连接你熟悉的编程工具。",action:"use",actionLabel:"在线开始使用"};
}
function nextAction(scope,state,primary=false){
 const waiting=pending(scope),showPending=waiting&&!state.canUse&&state.code!=="unavailable";
 return button(showPending?"pending":state.action,showPending?"查看申请进度":state.actionLabel,primary,'data-scope="'+esc(scope)+'"');
}
function button(action,text,primary=false,attrs=""){return '<button type="button" class="'+(primary?"primary":"ghost")+'" data-action="'+action+'" '+attrs+'>'+text+'</button>';}
function kv(k,v){return "<div><dt>"+k+"</dt><dd>"+v+"</dd></div>";}
function tag(text,warn=false){return '<span class="tag '+(warn?"warn":"")+'">'+text+'</span>';}
function scopeSelect(id,value,all=false){return '<select id="'+id+'" name="'+id+'">'+(all?'<option value="all">全部用途</option>':"")+scopes().map(x=>'<option value="'+x+'" '+(x===value?"selected":"")+'>'+esc(scopeLabel(x))+'</option>').join("")+'</select>';}
function go(nav){s.nav=nav;error="";notice="";rejecting=false;render();}
function fail(text){error=text;render();}
function switchRole(role){if(!roleNames[role])return;s.role=role;s.nav=role==="ops"?"overview":role==="employee"?"home":"approvals";s.tab="todo";s.keyId="";s.model="";prompt="";error="";notice="";rejecting=false;render();}
function selectedScope(id){if(!scopes().includes(id))return;s.selected[actor()]=id;s.model="";s.keyId="";}
function draftKey(){return actor()+":"+s.nav+":"+(s.nav==="budgetApply"||s.nav==="allocate"?s.project:current());}
function draft(){
 const key=draftKey();
 if(!s.drafts[key])s.drafts[key]={amount:s.nav==="budgetApply"?"5000":current()==="general"?"300":"2000",scene:"",reason:"",member:"chen",grantId:""};
 return s.drafts[key];
}
function related(r){return r&&(r.owner===actor()||r.reviewer===actor());}
// Model resources extend saved version 4 without replacing quota and approval records.
function initResources(){
 if(!s.resourceVersion){
  s.definitions=catalog.map((name,i)=>({id:'DEF-'+i,name,alias:['qwen-2.5','deepseek-v3','glm-4.6'][i],capability:'对话生成'}));
  const v={id:'SVC-DEMO',name:'企业模型服务 · 示例',url:'https://models.example.invalid/v1',credential:'demo-managed',enabled:true,models:s.definitions.map(d=>({definition:d.id,upstream:d.alias}))};
  v.check={status:'passed',signature:serviceSignature(v),at:TODAY+' · 预置模拟结果'};s.services=[v];
  for(const p of Object.values(s.pools))p.sources=Object.fromEntries(catalog.map(m=>[m,v.id]));
  s.resourceVersion=1;
 }
 s.resourceDrafts||={};s.resourceReturn||=[];
}
function modelCatalog(){return s.definitions.map(d=>d.name);}
function serviceSignature(d){return JSON.stringify([d.name,d.url,d.credential,d.models]);}
function serviceById(id){return s.services.find(x=>x.id===id);}
function sourceReady(id,model){const v=serviceById(id),def=s.definitions.find(d=>d.name===model);return !!v&&v.enabled!==false&&v.check?.status==='passed'&&v.check.signature===serviceSignature(v)&&v.models.some(m=>m.definition===def?.id);}
function serviceStatus(v){return v.enabled===false?'已停用':v.check?.status==='passed'&&v.check.signature===serviceSignature(v)?'模拟验证通过':v.check?.status==='failed'?'模拟验证失败':'待验证';}
function servicePools(id){return Object.entries(s.pools).filter(([,p])=>[...p.models,...p.staged].some(m=>p.sources?.[m]===id));}
function serviceImpact(id){const pools=servicePools(id),ids=pools.map(([key])=>key);return '<div class="notice warn"><b>变更影响</b><p>关联模型池：'+esc(pools.map(([,p])=>p.name).join('、')||'无')+'。</p><p>关联有效个人权益 '+s.entitlements.filter(e=>live(e)&&ids.includes(e.pool)).length+' 项、项目 '+s.projects.filter(p=>ids.includes(p.pool)).length+' 个。服务不可用时，对应来源模型停止新调用；其他服务来源仍可使用。已有额度与历史日志保留。</p></div>';}
function resourceTabs(){return '<div class="tabs resource-tabs" aria-label="模型资源分区">'+[['catalog','模型目录'],['services','模型服务'],['pools','模型池']].map(([id,label])=>'<button type="button" class="ghost" data-action="'+id+'" aria-pressed="'+(s.nav===id)+'">'+label+'</button>').join('')+'</div>';}
function resourceForm(type,key,content){return '<form data-form="'+type+'" data-resource-key="'+key+'" novalidate>'+content+'</form>';}
function resourceField(id,name,label,value,type='text'){return field(id,label,value,type).replace('name="'+id+'"','name="'+name+'"');}
function resourceBackLabel(fallback){const n=s.resourceReturn.at(-1)?.nav;return n==='serviceEdit'?'返回模型服务':n==='poolNew'||n==='pools'?'返回模型池':n==='planNew'?'返回个人方案':n==='projectNew'?'返回项目创建':fallback;}
function resourceReturn(fallback,result){
 const frame=s.resourceReturn.pop();
 if(frame){
  if(result?.definition&&frame.nav==='serviceEdit'){const d=s.resourceDrafts.service;d.models.push({definition:result.definition.id,upstream:result.definition.alias});d.check={status:'untested'};}
  if(result?.service&&(frame.nav==='pools'||frame.nav==='poolNew')){const d=frame.nav==='poolNew'?s.resourceDrafts.poolNew:s.accessDrafts[frame.key];d.sources||={};for(const m of result.service.models){const name=s.definitions.find(x=>x.id===m.definition).name;if(!d.states[name]||d.states[name]==='off'){d.states[name]='staged';d.sources[name]=result.service.id;}}d.preview=false;}
  if(result?.pool&&frame.key){const d=s.accessDrafts[frame.key];if(d){d.pool=result.pool;d.allowed=[];d.preview=false;}}
  s.nav=frame.nav;
 }else s.nav=fallback;
}
function serviceValid(d){
 if(!d.name.trim())return '请填写模型服务名称。';
 try{const u=new URL(d.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error();}catch{return '请填写 HTTP(S) 服务地址，不包含账号、密码、查询参数或片段。';}
 if(!['demo-managed','none'].includes(d.credential))return '请选择凭据引用方式。';
 if(!d.models.length)return '至少选择一个目录模型。';
 if(d.models.some(m=>!s.definitions.some(x=>x.id===m.definition)||!m.upstream.trim()))return '请为所选模型填写上游模型标识。';
 if(new Set(d.models.map(m=>m.upstream.trim())).size!==d.models.length)return '同一服务中的上游模型标识不能重复。';return '';
}
function resourceRemember(form){
 const key=form.dataset.resourceKey,d=s.resourceDrafts[key];if(!d)return null;
 const before=key==='service'?serviceSignature(d):'';
 for(const [k,v] of new FormData(form))if(!k.startsWith('upstream_')&&!k.startsWith('source_'))d[k]=v;
 if(key==='service')for(const row of d.models){const el=form.querySelector('[data-upstream="'+row.definition+'"]');if(el)row.upstream=el.value;}
 if(d.states)for(const el of form.querySelectorAll('[data-pool-model]'))d.states[el.dataset.poolModel]=el.value;
 if(d.sources)for(const el of form.querySelectorAll('[data-pool-source]'))d.sources[el.dataset.poolSource]=el.value;
 if(key==='service'&&before!==serviceSignature(d))d.check={status:'untested'};
 return d;
}
function poolSourceOptions(model,selected){const def=s.definitions.find(d=>d.name===model);return '<option value="">选择模型服务</option>'+s.services.filter(v=>v.models.some(m=>m.definition===def?.id)).map(v=>'<option value="'+v.id+'" '+(selected===v.id?'selected':'')+'>'+esc(v.name)+' · '+serviceStatus(v)+'</option>').join('');}
function poolRows(d){
 d.sources||={};
 return '<div class="pool-rows">'+modelCatalog().map((m,i)=>'<div class="pool-entry"><div><b>'+esc(m)+'</b><small>'+esc(s.definitions[i].alias)+'</small></div><div class="field"><label for="poolSource'+i+'">模型来源</label><select id="poolSource'+i+'" data-pool-source="'+esc(m)+'">'+poolSourceOptions(m,d.sources[m])+'</select></div><div class="field"><label for="poolModel'+i+'">开放状态</label><select id="poolModel'+i+'" data-pool-model="'+esc(m)+'">'+[['off','未加入 / 关闭'],['staged','已加入 · 未开放'],['open','已开放']].map(([v,l])=>'<option value="'+v+'" '+((d.states[m]||'off')===v?'selected':'')+'>'+l+'</option>').join('')+'</select></div></div>').join('')+'</div><p class="state-help">同一池内，一个模型标识只选择一个服务来源。多个池引用同一服务时仍共享其底层容量，当前继承企业默认使用限制。</p>';
}
function validatePoolDraft(d){for(const m of modelCatalog().filter(m=>['staged','open'].includes(d.states[m]))){const v=serviceById(d.sources?.[m]),def=s.definitions.find(x=>x.name===m);if(!v||!v.models.some(x=>x.definition===def.id))return m+' 尚未选择实际服务来源。';if(d.states[m]==='open'&&!sourceReady(v.id,m))return m+' 的服务尚未通过模拟验证或已停用，不能开放。可先保存为已加入、未开放。';}return '';}
// Model access is separate from balances. Pool membership follows only an explicit range binding.
function catalogView(){return resourceTabs()+'<section class="panel"><div class="head"><div><h2>模型目录</h2><p class="state-help">复用模型名称与对外标识，连接地址在模型服务中管理。</p></div>'+button('definitionNew','新建模型定义',true)+'</div><div class="tablewrap"><table><thead><tr><th>模型</th><th>对外标识</th><th>能力</th><th>提供服务</th></tr></thead><tbody>'+s.definitions.map(d=>'<tr><td>'+esc(d.name)+'</td><td>'+esc(d.alias)+'</td><td>'+esc(d.capability)+'</td><td>'+s.services.filter(v=>v.models.some(m=>m.definition===d.id)).length+' 个</td></tr>').join('')+'</tbody></table></div></section>';}
function definitionForm(){const d=s.resourceDrafts.definition;return '<section class="panel"><h2>新建模型定义</h2><p class="state-help">'+resourceBackLabel('保存后返回模型目录')+'，原表单内容保留。</p>'+resourceForm('definitionSave','definition',resourceField('definitionName','name','模型名称',d.name)+resourceField('modelAlias','alias','对外模型标识',d.alias)+field('capability','能力说明',d.capability)+'<p class="state-help">模型标识在目录内唯一。定义模型不代表服务已经支持它。</p><div class="button-row"><button type="submit" class="primary">保存模型定义</button>'+button('resourceCancel',resourceBackLabel('取消'))+'</div>')+'</section>';}
function servicesView(){return resourceTabs()+'<section class="panel"><div class="head"><div><h2>模型服务</h2><p class="state-help">接入已经部署的内部模型平台或供应商服务。</p></div>'+button('serviceNew','接入模型服务',true)+'</div>'+(s.services.length?s.services.map(v=>'<article class="service-item"><div class="head"><div><h3>'+esc(v.name)+'</h3><small>'+esc(v.url)+'</small></div>'+tag(serviceStatus(v),!v.enabled||v.check?.status!=='passed')+'</div><p>'+v.models.map(m=>'<span class="model-chip">'+esc(s.definitions.find(d=>d.id===m.definition)?.name)+'</span>').join(' ')+'</p><p class="secondary">关联 '+servicePools(v.id).length+' 个模型池 · 凭据仅为演示引用</p><div class="button-row">'+button('serviceEdit','查看 / 配置',false,'data-id="'+v.id+'"')+button('serviceToggle',v.enabled===false?'预览启用':'预览停用',false,'data-id="'+v.id+'"')+'</div>'+(s.serviceToggle===v.id?serviceImpact(v.id)+'<div class="button-row">'+button('confirmServiceToggle',v.enabled===false?'确认启用':'确认停用',false,'data-id="'+v.id+'"')+button('cancelServiceToggle','取消')+'</div>':'')+'</article>').join(''):'<div class="empty">尚未接入模型服务。从一个已经部署的模型开始。</div>')+'</section>';}
function serviceForm(){
 const d=s.resourceDrafts.service,status=d.check?.status||'untested',messages={untested:'尚未模拟验证。可先保存配置，验证通过前不能开放到模型池。',checking:'正在模拟验证连接与模型映射…',passed:'模拟验证通过。保存后才更新服务配置；不代表真实连接验证。',failed:d.check?.reason||'模拟验证失败，请检查配置后重试。'};
 return resourceTabs()+'<section class="panel"><div class="head"><h2>'+(d.id?'配置模型服务':'接入模型服务')+'</h2>'+tag('连接演示 · 不发送请求',true)+'</div><p class="state-help">'+resourceBackLabel('保存后返回模型服务列表')+'。</p>'+resourceForm('serviceSave','service','<div class="form-grid">'+resourceField('serviceName','name','服务名称',d.name)+resourceField('serviceUrl','url','服务地址',d.url,'url')+'</div><div class="field"><label for="credentialRef">访问凭据</label><select id="credentialRef" name="credential"><option value="demo-managed" '+(d.credential==='demo-managed'?'selected':'')+'>企业托管凭据 · 演示引用</option><option value="none" '+(d.credential==='none'?'selected':'')+'>无需凭据</option></select><small>原型不接收真实密钥。正式产品由受控凭据管理提供引用。</small></div><div class="head"><h3>服务提供的模型</h3>'+button('definitionNew','新建模型定义',false,'data-inline="true"')+'</div>'+s.definitions.map(def=>{const row=d.models.find(m=>m.definition===def.id);return '<div class="service-model"><label><input type="checkbox" data-service-definition="'+def.id+'" '+(row?'checked':'')+'> '+esc(def.name)+' <small>'+esc(def.alias)+'</small></label>'+(row?'<div class="field"><label for="upstream_'+def.id+'">上游模型标识</label><input id="upstream_'+def.id+'" data-upstream="'+def.id+'" value="'+esc(row.upstream)+'"></div>':'')+'</div>';}).join('')+'<div class="demo-controls"><label for="validationCase">验证情景 · 仅供原型评审</label><select id="validationCase" name="scenario">'+[['passed','模拟通过'],['timeout','模拟连接超时'],['auth','模拟鉴权失败'],['missing','模拟模型不存在']].map(([v,l])=>'<option value="'+v+'" '+(d.scenario===v?'selected':'')+'>'+l+'</option>').join('')+'</select></div><div class="notice '+(status==='failed'?'error':'')+'" id="validationResult" role="status">'+esc(messages[status])+'</div><p class="state-help">服务与模型当前继承企业默认使用限制。修改地址、凭据引用或模型映射后，旧验证结果失效。</p>'+(d.preview?serviceImpact(d.id):'')+'<div class="button-row">'+button('serviceValidate',status==='checking'?'验证中…':'模拟验证连接',false,status==='checking'?'disabled':'')+'<button type="submit" class="primary" '+(status==='checking'?'disabled':'')+'>'+(d.preview?'确认保存并更新关联来源':'保存模型服务')+'</button>'+button('resourceCancel',resourceBackLabel('取消'))+'</div>')+'</section>';
}
function poolCreateForm(){const d=s.resourceDrafts.poolNew;return resourceTabs()+'<section class="panel"><div class="head"><h2>新建用途模型池</h2>'+button('serviceNew','接入新服务',false,'data-inline="true"')+'</div><p class="state-help">'+resourceBackLabel('保存后进入模型池配置')+'。已保存的模型定义与服务不会因取消本页而删除。</p>'+resourceForm('poolCreate','poolNew',resourceField('poolName','name','模型池名称',d.name)+poolRows(d)+(d.preview?'<div class="notice"><b>确认开放范围</b><p>'+esc(modelCatalog().filter(m=>d.states[m]==='open').join('、')||'尚无已开放模型')+'</p>保存只建立模型池，不自动设置默认池、开通人员或发放额度。</div>':'')+'<div class="button-row"><button type="submit" class="primary">'+(d.preview?'确认创建模型池':'预览模型池')+'</button>'+button('resourceCancel',resourceBackLabel('取消'))+'</div>')+'</section>';}
function projectGrantForm(){const p=project(s.project),d=s.resourceDrafts.projectGrant;return '<section class="panel"><h2>发放项目总额度</h2><div class="context-strip"><strong>'+esc(p.name)+'</strong><span>进入项目待分配额度</span></div>'+resourceForm('projectGrantSave','projectGrant',resourceField('grantAmount','amount','发放金额（元）',d.amount)+resourceField('grantExpiry','expiry','额度有效至',d.expiry,'date')+resourceField('grantReason','reason','发放说明',d.reason)+(d.preview?'<div class="notice">将新增 '+money(cents(d.amount))+' 的项目批次，有效至 '+esc(d.expiry)+'（上海时间当日结束）。现有批次期限不变，成员余额暂不增加。</div>':'')+'<div class="button-row"><button class="primary" type="submit">'+(d.preview?'确认发放到项目':'预览发放')+'</button>'+button('resourceCancel','返回项目')+'</div>')+'</section>';}
function projectMembersForm(){const p=project(s.project),candidates=['chen','zhao'].filter(u=>!p.members.includes(u));return '<section class="panel"><h2>添加项目成员</h2><p>'+esc(p.name)+'</p>'+(candidates.length?resourceForm('projectMemberSave','projectMember','<div class="field"><label for="newMember">企业成员</label><select name="member" id="newMember">'+candidates.map(u=>'<option value="'+u+'">'+people[u]+'</option>').join('')+'</select></div><div class="notice">加入后继承项目模型范围，个人在项目中的额度仍为零。下一步可从项目批次分配。</div><div class="button-row"><button class="primary" type="submit">添加并继续分配</button>'+button('resourceCancel','返回项目')+'</div>'):'<div class="empty">演示成员均已加入此项目。</div>'+button('projects','返回项目'))+'</section>';}
function onboardingGuide(){return '<section class="panel"><div class="head"><div><h2>从模型接入到员工可用</h2><p class="state-help">先准备资源，再选择个人或项目开通路径。</p></div>'+tag('运营开通闭环')+'</div><div class="onboarding-grid"><article><span class="eyebrow">01 · 接入来源</span><h3>登记已部署的模型服务</h3><p>选择目录模型，填写上游标识，模拟验证连接。</p>'+button('services','接入 / 查看服务')+'</article><article><span class="eyebrow">02 · 组织范围</span><h3>配置用途模型池</h3><p>选择实际来源，预览开放范围，设置个人与项目默认池。</p>'+button('pools','配置模型池')+'</article><article><span class="eyebrow">03 · 开通使用</span><h3>明确资源发给谁</h3><p>个人通过开通方案获得权益；项目先有预算，再分配到成员。</p><div class="button-row">'+button('planNew','个人开通方案')+button('projectNew','创建项目')+'</div></article></div></section>';}
function accessDraft(key,initial){return s.accessDrafts[key]||(s.accessDrafts[key]=copy(initial));}
function resourceView(){
 const opsViews=['catalog','services','definitionNew','serviceEdit','poolNew','projectGrant'];
 if(opsViews.includes(s.nav)&&s.role!=='ops')return '<section class="panel">此配置由运营人员管理。</section>';
 if(s.nav==='projectMembers'&&!canManage(project(s.project)))return '<section class="panel">没有项目成员管理权限。</section>';
 switch(s.nav){case 'catalog':return catalogView();case 'services':return servicesView();case 'definitionNew':return definitionForm();case 'serviceEdit':return serviceForm();case 'poolNew':return poolCreateForm();case 'projectGrant':return projectGrantForm();case 'projectMembers':return projectMembersForm();default:return null;}
}
function resourceAction(action,b){
 const names=['catalog','services','definitionNew','serviceNew','serviceEdit','serviceValidate','serviceToggle','confirmServiceToggle','cancelServiceToggle','poolNew','resourceCancel','projectGrant','projectMembers'];
 if(!names.includes(action))return false;
 if(s.role!=='ops'&&!(action==='projectMembers'&&canManage(project(s.project)))&&!(action==='resourceCancel'&&s.nav==='projectMembers')){fail('此操作由运营人员处理。');return true;}
 if(action==='catalog'||action==='services'){s.resourceReturn=[];go(action);return true;}
 if(action==='resourceCancel'){
  const fallback=['projectGrant','projectMembers'].includes(s.nav)?'projects':s.nav==='definitionNew'?'catalog':s.nav==='poolNew'?'pools':'services';
  if(s.nav==='serviceEdit'&&s.resourceDrafts.service?.check?.status==='checking')s.resourceDrafts.service.check={status:'untested'};
  resourceReturn(fallback);render();return true;
 }
 if(['definitionNew','serviceNew','poolNew'].includes(action)){
  if(b.dataset.inline){const form=b.closest('form');if(form?.dataset.resourceKey)resourceRemember(form);if(form?.dataset.accessKey)rememberAccess(form);s.resourceReturn.push({nav:s.nav,key:form?.dataset.accessKey||(s.nav==='pools'?'pool:'+s.poolId:'')});}else s.resourceReturn=[];
  if(action==='definitionNew'){s.resourceDrafts.definition={name:'',alias:'',capability:'对话生成'};s.nav='definitionNew';}
  if(action==='serviceNew'){s.resourceDrafts.service={name:'',url:'https://models.example.invalid/v1',credential:'demo-managed',models:[],enabled:true,scenario:'passed',check:{status:'untested'}};s.nav='serviceEdit';}
  if(action==='poolNew'){s.resourceDrafts.poolNew={name:'',states:{},sources:{},preview:false};s.nav='poolNew';}
 }else if(action==='serviceEdit'){
  const v=serviceById(b.dataset.id);if(!v)return true;s.resourceDrafts.service={...copy(v),scenario:'passed',preview:false};s.resourceReturn=[];s.nav='serviceEdit';
 }else if(action==='serviceValidate'){
  const d=resourceRemember(b.closest('form')),reason=serviceValid(d);if(reason){fail(reason);return true;}
  const signature=serviceSignature(d),scenario=d.scenario;d.check={status:'checking'};d.preview=false;render();
  setTimeout(()=>{if(s.resourceDrafts.service!==d||d.check.status!=='checking'||serviceSignature(d)!==signature||d.scenario!==scenario)return;
   const reasons={timeout:'模拟连接超时：请检查服务地址与网络访问范围。配置已保留，可重试。',auth:'模拟鉴权失败：请检查凭据引用及服务访问权限。配置已保留。',missing:'模拟模型不存在：请核对服务实际支持的上游模型标识。配置已保留。'};
   d.check={status:scenario==='passed'?'passed':'failed',signature,at:time(),reason:reasons[scenario]||''};if(s.nav==='serviceEdit'&&s.role==='ops')render();else save();
  },450);return true;
 }else if(action==='serviceToggle'){s.serviceToggle=b.dataset.id;}
 else if(action==='cancelServiceToggle'){s.serviceToggle='';}
 else if(action==='confirmServiceToggle'){
  const v=serviceById(b.dataset.id);if(!v||s.serviceToggle!==v.id)return true;
  if(v.enabled===false&&!(v.check?.status==='passed'&&v.check.signature===serviceSignature(v))){fail('服务配置尚未验证通过，请先配置并模拟验证。');return true;}
  v.enabled=v.enabled===false;s.serviceToggle='';audit(v.name+(v.enabled?' 已启用':' 已停用')+'；对应来源的新调用状态同步更新，额度未变。');notice='服务状态已更新；历史记录与余额保留。';
 }else if(action==='projectGrant'){s.resourceReturn=[];s.resourceDrafts.projectGrant={project:s.project,amount:'1000',expiry:'2026-12-31',reason:'',preview:false};s.nav='projectGrant';}
 else if(action==='projectMembers'){s.resourceReturn=[];s.resourceDrafts.projectMember={project:s.project,member:''};s.nav='projectMembers';}
 render();return true;
}
function resourceSubmit(form){
 if(!form.dataset.resourceKey)return false;
 const d=resourceRemember(form),type=form.dataset.form;
 if(!d){fail('草稿已失效，请返回重新打开。');return true;}
 if(s.role!=='ops'&&!(type==='projectMemberSave'&&canManage(project(s.project)))){fail('此操作由运营人员处理。');return true;}
 if(type==='definitionSave'){
  if(!d.name.trim()||!d.capability.trim()||!/^[-a-zA-Z0-9._/]{1,80}$/.test(d.alias)){fail('请填写模型名称与能力说明，模型标识使用 1–80 位字母、数字、点、斜线、下划线或短横线。');return true;}
  if(s.definitions.some(x=>x.name===d.name.trim()||x.alias.toLowerCase()===d.alias.toLowerCase())){fail('模型名称或对外标识已存在，请复用目录定义。');return true;}
  const def={id:'DEF-'+s.seq++,name:d.name.trim(),alias:d.alias,capability:d.capability.trim()};s.definitions.push(def);resourceReturn('catalog',{definition:def});notice='模型定义已保存，尚未接入实际服务。';
 }else if(type==='serviceSave'){
  const reason=serviceValid(d);if(reason){fail(reason);return true;}if(d.check?.status==='checking')return true;
  if(d.id&&servicePools(d.id).length&&!d.preview){d.preview=true;render();return true;}
  const v={id:d.id||'SVC-'+s.seq++,name:d.name,url:d.url,credential:d.credential,models:copy(d.models),enabled:d.enabled!==false,check:copy(d.check||{status:'untested'})};
  const i=s.services.findIndex(x=>x.id===v.id);if(i<0)s.services.push(v);else s.services[i]=v;
  audit(v.name+' 配置已保存 · '+serviceStatus(v));resourceReturn('services',{service:v});notice=serviceStatus(v)+'，配置已保存；在模型池中预览并开放后才供员工使用。';
 }else if(type==='poolCreate'){
  if(!d.name.trim()||Object.values(s.pools).some(p=>p.name===d.name.trim())){fail('请填写不重复的模型池名称。');return true;}
  const reason=validatePoolDraft(d);if(reason){fail(reason);return true;}if(!d.preview){d.preview=true;render();return true;}
  const id='POOL-'+s.seq++;s.pools[id]={name:d.name.trim(),models:modelCatalog().filter(m=>d.states[m]==='open'),staged:modelCatalog().filter(m=>d.states[m]==='staged'),sources:copy(d.sources)};s.poolId=id;resourceReturn('pools',{pool:id});audit('新建模型池 '+d.name+'，尚未新增人员权益或项目预算。');notice='模型池已创建。可设置为新建默认值，或继续选择方案 / 项目开通。';
 }else if(type==='projectGrantSave'){
  const p=project(d.project),n=cents(d.amount);if(!p||p.id!==s.project||!n||!validDate(d.expiry)||!d.reason.trim()){fail('请确认项目、有效金额、到期日期和发放说明。');return true;}
  if(!d.preview){d.preview=true;render();return true;}
  const g={id:'GRANT-'+s.seq++,amount:n,expiry:d.expiry,source:'运营直接发放 · '+d.reason.trim()};p.grants.push(g);delete s.resourceDrafts.projectGrant;s.nav='projects';audit(p.name+' 新增项目额度 '+money(n));notice='已发放到项目批次 '+g.id+'。下一步添加成员并分配，成员余额未自动增加。';
 }else if(type==='projectMemberSave'){
  const p=project(d.project);if(!p||p.id!==s.project||!canManage(p)||!['chen','zhao'].includes(d.member)){fail('请选择有权管理的项目与有效企业成员。');return true;}
  if(!p.members.includes(d.member)){p.members.push(d.member);s.wallets[d.member][p.id]||=[];audit(people[d.member]+' 加入 '+p.name+'，尚未分配额度。');}
  s.nav='allocate';Object.assign(draft(),{member:d.member,amount:'100',grantId:''});notice='成员已加入项目，继承项目模型范围；请从项目批次分配额度。';
 }
 render();return true;
}
function poolOptions(value){return Object.entries(s.pools).map(([id,p])=>'<option value="'+id+'" '+(id===value?'selected':'')+'>'+esc(p.name)+'</option>').join('');}
function rangeSummary(b){return '<div class="range-summary"><span class="eyebrow">'+esc(s.pools[b.pool]?.name||'未选择模型池')+'</span><b>'+ (b.mode==='subset'?'仅开放指定模型':'跟随模型池')+'</b><p>'+ (rangeModels(b).map(m=>'<span class="model-chip">'+esc(m)+'</span>').join('')||'当前无已开放模型，暂不可调用')+'</p><small>'+(b.mode==='subset'?'新增模型不自动加入；停用或移出池的模型不可调用。':'池内后续开放的模型同步可用；尚未开放的模型不提供调用。')+'</small></div>';}
function rangeEditor(d){return '<div class="field"><label for="accessPool">模型池</label><select id="accessPool" name="pool">'+poolOptions(d.pool)+'</select></div><fieldset class="range-mode"><legend>可用模型范围</legend><label><input type="radio" name="mode" value="follow" '+(d.mode==='follow'?'checked':'')+'> 跟随模型池（推荐）</label><label><input type="radio" name="mode" value="subset" '+(d.mode==='subset'?'checked':'')+'> 限制可用模型</label></fieldset>'+(d.mode==='subset'?'<fieldset class="model-options"><legend>仅开放指定模型</legend>'+(s.pools[d.pool]?.models||[]).map(m=>'<label><input type="checkbox" name="allowed" value="'+esc(m)+'" '+(d.allowed.includes(m)?'checked':'')+'> '+esc(m)+'</label>').join('')+'</fieldset>':'')+rangeSummary(d);}
function validRange(d){return !!s.pools[d.pool]&&['follow','subset'].includes(d.mode)&&(d.mode!=='subset'||d.allowed.length>0&&d.allowed.every(m=>s.pools[d.pool].models.includes(m)));}
function field(id,label,value='',type='text'){return '<div class="field"><label for="'+id+'">'+label+'</label><input id="'+id+'" name="'+id+'" type="'+type+'" value="'+esc(value)+'" required></div>';}
function boundForm(form,key,content){return '<form data-form="'+form+'" data-access-key="'+key+'" novalidate>'+content+'</form>';}
function poolImpact(id,next){
 const bindings=[...s.plans.map(p=>({...p,label:'方案 · '+p.name})),...s.entitlements.filter(live).map(e=>({...e,label:people[e.owner]+' · '+e.name})),...s.projects.map(p=>({...p,label:'项目 · '+p.name}))].filter(b=>b.pool===id);
 return bindings.map(b=>{const before=configuredRange(b),after=b.mode==='subset'?next.filter(m=>b.allowed.includes(m)):next;return {...b,added:after.filter(m=>!before.includes(m)),removed:before.filter(m=>!after.includes(m))};});
}
function poolsView(){
 const defaults=accessDraft('defaults',s.defaults);if(!s.pools[s.poolId])s.poolId=Object.keys(s.pools)[0]||'';
 const p=s.pools[s.poolId];if(!p)return resourceTabs()+'<section class="panel"><h2>用途模型池</h2><div class="empty">尚无模型池。创建后再设置个人与项目默认池。</div>'+button('poolNew','新建模型池',true)+'</section>';
 const d=accessDraft('pool:'+s.poolId,{states:Object.fromEntries(modelCatalog().map(m=>[m,p.models.includes(m)?'open':p.staged.includes(m)?'staged':'off'])),sources:copy(p.sources)});d.sources||=copy(p.sources);
 const next=modelCatalog().filter(m=>d.states[m]==='open'),affected=poolImpact(s.poolId,next),rerouted=next.filter(m=>p.models.includes(m)&&d.sources[m]!==p.sources[m]);
 return resourceTabs()+'<section class="panel"><div class="head"><h2>默认模型池</h2>'+button('poolNew','新建模型池',true)+'</div>'+boundForm('defaults','defaults','<div class="form-grid"><div class="field"><label for="personalDefault">个人默认模型池</label><select id="personalDefault" name="personal">'+poolOptions(defaults.personal)+'</select><small>用于新建个人开通方案，不迁移存量。</small></div><div class="field"><label for="projectDefault">项目默认模型池</label><select id="projectDefault" name="project">'+poolOptions(defaults.project)+'</select><small>用于项目创建与审批时预填。</small></div></div><button class="ghost" type="submit">保存默认配置</button>')+'</section><section class="panel"><div class="head"><h2>池内模型与开放状态</h2>'+button('serviceNew','接入新服务',false,'data-inline="true"')+'</div><div class="field"><label for="poolPicker">当前模型池</label><select id="poolPicker">'+poolOptions(s.poolId)+'</select></div>'+boundForm('poolPreview','pool:'+s.poolId,poolRows(d)+'<div class="button-row"><button class="primary" type="submit">预览变更影响</button></div>')+'</section>'+(d.preview?'<section class="panel impact-panel"><div class="head"><h2>变更影响预览</h2>'+tag('尚未生效',true)+'</div><p>即将开放：'+esc(next.join('、')||'无')+'。不会新增或转移额度。</p>'+(rerouted.length?'<div class="notice warn">以下模型将更换实际服务来源：'+esc(rerouted.join('、'))+'。所有使用这些模型的关联范围均受影响，历史日志保留原来源。</div>':'')+'<div class="tablewrap"><table><thead><tr><th>关联对象</th><th>范围模式</th><th>本次权限变化</th></tr></thead><tbody>'+affected.map(b=>'<tr><td>'+esc(b.label)+'</td><td>'+(b.mode==='follow'?'跟随模型池':'仅指定模型')+'</td><td>'+esc([b.added.length?'新增 '+b.added.join('、'):'',b.removed.length?'关闭 '+b.removed.join('、'):''].filter(Boolean).join('；')||'范围保持不变')+'</td></tr>').join('')+'</tbody></table></div><p class="secondary">跟随模式同步开放新增模型；指定模式不扩大范围。关闭模型同时影响两种模式。</p><div class="button-row">'+button('confirmPool','确认变更并生效',true)+button('cancelPool','返回修改')+'</div></section>':'')+'<section class="panel"><h2>最近配置记录</h2>'+(s.audit.slice(-6).reverse().map(a=>'<p class="secondary">'+esc(a.time+' · '+a.text)+'</p>').join('')||'<p class="secondary">尚无本轮配置变更。</p>')+'</section>';
}

function plansView(){return '<section class="panel"><div class="head"><h2>个人开通方案</h2>'+button('planNew','新建方案',true)+'</div><p class="secondary">方案定义可用模型与额度规则。人员开通时保留授权配置；后续池内变化遵循所选范围模式。</p><div class="plan-grid">'+s.plans.map(p=>'<article class="plan-tile"><h3>'+esc(p.name)+'</h3>'+rangeSummary(p)+'<p class="secondary">'+(p.cycle==='monthly'?'每月':'一次性')+' '+money(p.amount)+' · 有效至 '+p.expiry+'</p>'+button('members','开通给人员',false,'data-plan="'+p.id+'"')+'</article>').join('')+'</div></section>';}
function planForm(){const d=accessDraft('newPlan',{name:'',pool:s.defaults.personal,mode:'follow',allowed:[],amount:'300',cycle:'monthly',expiry:'2026-12-31'});return '<section class="panel"><h2>新建个人开通方案</h2>'+boundForm('planCreate','newPlan',field('name','方案名称',d.name)+rangeEditor(d)+'<div class="form-grid">'+field('amount','发放金额（元）',d.amount)+'<div class="field"><label for="cycle">发放方式</label><select id="cycle" name="cycle"><option value="monthly" '+(d.cycle==='monthly'?'selected':'')+'>每月</option><option value="once" '+(d.cycle==='once'?'selected':'')+'>一次性</option></select></div>'+field('expiry','方案有效至',d.expiry,'date')+'</div><p class="secondary">继承默认使用限制；本地演示只发放首次额度，未接入月度调度。</p><div class="button-row"><button class="primary" type="submit">保存方案</button>'+button('plans','取消')+'</div>')+'</section>';}
function personalRights(user){return '<div class="plan-grid">'+rights(user).map(e=>'<article class="plan-tile"><h3>'+esc(e.name)+'</h3>'+rangeSummary(e)+'<p class="secondary">权益 '+e.id+' · 有效至 '+e.expiry+'</p></article>').join('')+'</div>'+(rights(user).length?'':'<div class="empty">尚未开通个人模型权限，可申请开通。</div>');}
function membersView(){const d=accessDraft('memberOpen',{planId:s.plans[0]?.id});const p=s.plans.find(p=>p.id===d.planId)||s.plans[0];return '<section class="panel"><div class="head"><h2>成员详情 · AI 使用权益</h2><span>多项方案分别追溯</span></div><div class="field"><label for="memberPicker">查看成员</label><select id="memberPicker">'+['chen','zhao'].map(u=>'<option value="'+u+'" '+(s.memberId===u?'selected':'')+'>'+people[u]+'</option>').join('')+'</select></div>'+personalRights(s.memberId)+'</section><section class="panel"><h2>开通个人方案</h2>'+boundForm('memberOpen','memberOpen','<div class="field"><label for="planId">个人开通方案</label><select id="planId" name="planId">'+s.plans.map(p=>'<option value="'+p.id+'" '+(p.id===d.planId?'selected':'')+'>'+esc(p.name)+'</option>').join('')+'</select></div>'+rangeSummary(p)+'<div class="notice">本次给 '+people[s.memberId]+' 开通，首次发放 '+money(p.amount)+'，有效至 '+p.expiry+'。已有同方案有效权益不会重复开通或发放。</div><div class="button-row"><button class="primary" type="submit">确认开通并发放</button></div>')+'</section>';}
function personalReview(r,d){
 const access=r.intent==='access',entries=access?s.plans:rights(r.owner),key=access?'planId':'entitlementId';
 if(!d[key]||!entries.some(x=>x.id===d[key]))d[key]=entries[0]?.id||'';
 const selected=entries.find(x=>x.id===d[key]);
 return '<div class="field"><label for="reviewBinding">'+(access?'选择个人开通方案':'追加到已有权益')+'</label><select id="reviewBinding" name="'+key+'">'+entries.map(x=>'<option value="'+x.id+'" '+(x.id===d[key]?'selected':'')+'>'+esc(x.name)+'</option>').join('')+'</select></div>'+(selected?rangeSummary(selected):'<p class="notice warn">没有有效权益，请先按开通流程授予模型权限。</p>')+'<p class="secondary">'+(access?'按方案授予权限，本次只发放上方批准金额，不叠加方案首期金额。':'只追加资金，不改变模型池、范围或既有权益有效期。')+'</p>';
}
function openEntitlement(user,p){const existing=rights(user).find(e=>e.planId===p.id);if(existing)return existing;const e={id:'ENT-'+s.seq++,owner:user,planId:p.id,name:p.name,pool:p.pool,mode:p.mode,allowed:copy(p.allowed),expiry:p.expiry};s.entitlements.push(e);return e;}
function createProject(d,owner){const p={id:'PRJ-'+s.seq++,name:d.name.trim(),manager:d.manager||'zhao',members:[...new Set([owner,d.manager||'zhao'])],pool:d.pool,mode:d.mode,allowed:copy(d.allowed),grants:[]};s.projects.push(p);p.members.forEach(u=>s.wallets[u][p.id]=[]);s.project=p.id;return p;}
function projectForm(){const ops=s.role==='ops',key=ops?'newProject':'projectApplication',d=accessDraft(key,ops?{name:'',reason:'',manager:'zhao',pool:s.defaults.project,mode:'follow',allowed:[]}:{name:'',reason:''});return '<section class="panel"><h2>'+(ops?'创建项目':'申请创建项目')+'</h2>'+boundForm('projectCreate',key,field('name','项目名称',d.name)+field('reason','业务用途与说明',d.reason)+(ops?'<div class="field"><label for="manager">项目经理</label><select id="manager" name="manager"><option value="zhao">赵宁</option></select></div>'+rangeEditor(d):'<div class="notice">无需选择模型池。运营审批时确认项目经理和模型范围；创建获批后再申请项目总额度。</div>')+'<div class="button-row"><button class="primary" type="submit">'+(ops?'确认创建项目':'提交项目申请')+'</button>'+button(ops?'projects':'myProjects','取消')+'</div>')+'</section>';}
function myProjects(){return '<section class="panel"><div class="head"><h2>我的项目</h2>'+button('projectNew','申请创建项目',true)+'</div>'+s.projects.filter(p=>p.members.includes(actor())).map(p=>'<article class="project-line"><h3>'+esc(p.name)+'</h3>'+rangeSummary(p)+'<p class="secondary">我的项目额度 '+money(balance(p.id))+' · 经理 '+people[p.manager]+'</p>'+button('select','查看我的额度',false,'data-scope="'+p.id+'"')+'</article>').join('')+'</section>';}
function projectCreationReview(r){
 const key='projectReview:'+r.id,d=accessDraft(key,{name:r.name,reason:r.reason,manager:'zhao',pool:s.defaults.project,mode:'follow',allowed:[],comment:''});
 let h='<section class="panel"><div class="head"><h2>创建项目申请</h2>'+tag(labels[r.status],r.status==='pending')+'</div><dl class="facts">'+kv('项目',esc(r.name))+kv('申请人',people[r.owner])+kv('业务用途',esc(r.reason))+kv('申请编号',r.id)+'</dl>';
 if(r.status!=='pending')return h+'<div class="notice">'+(r.status==='approved'?'项目已创建，预算与成员余额尚未发放。':'申请已驳回：'+esc(r.comment))+'</div><div class="button-row">'+(r.status==='approved'?(s.role==='ops'?button('projects','查看项目并继续',true,'data-project="'+r.scope+'"'):button('select','查看我的项目额度',true,'data-scope="'+r.scope+'"')):r.owner===actor()?button('reapplyProject','修改后重新申请',true):'')+'</div></section>';
 if(r.reviewer!==actor())return h+'<p class="notice">等待运营确认项目经理和模型范围。</p><div class="button-row">'+button('reviewer','去审批方查看')+'</div></section>';
 return h+boundForm('projectApprove',key,'<div class="field"><label for="manager">项目经理</label><select id="manager" name="manager"><option value="zhao">赵宁</option></select></div>'+rangeEditor(d)+field('comment','审批意见 / 驳回原因',d.comment)+'<div class="notice">确认后创建项目，所有成员沿用此范围。不会自动发放项目预算。</div><div class="button-row"><button class="primary" type="submit">批准并创建项目</button>'+button('rejectProject','驳回项目申请')+'</div>')+'</section>';
}
function projectRangeView(){const p=project(s.project),key='projectRange:'+p.id,d=accessDraft(key,{pool:p.pool,mode:p.mode,allowed:copy(p.allowed)});return '<section class="panel"><h2>'+esc(p.name)+' · 模型与使用范围</h2>'+boundForm('projectRange',key,rangeEditor(d)+'<div class="notice">影响本项目 '+p.members.length+' 位成员及 '+s.keys.filter(k=>k.scope===p.id).length+' 把演示凭证。余额不转移、不追加，成员统一继承范围。</div><div class="button-row"><button class="primary" type="submit">预览范围变更</button>'+button('projects','取消')+'</div>')+(d.preview?'<div class="impact-panel"><h3>确认项目范围变更</h3><p>原范围：'+esc(rangeModels(p).join('、')||'无')+'</p><p>变更后：'+esc(rangeModels(d).join('、')||'无')+'</p>'+button('confirmRange','确认范围变更',true)+'</div>':'')+'</section>';}
function accessView(){if(['pools','plans','planNew','members','projectRange'].includes(s.nav)&&s.role!=='ops')return '<section class="panel">该配置由运营人员管理。</section>';switch(s.nav){case 'pools':return poolsView();case 'plans':return plansView();case 'planNew':return planForm();case 'members':return membersView();case 'myProjects':return myProjects();case 'projectNew':return projectForm();case 'projectRange':return projectRangeView();default:return null;}}
function audit(text){s.audit.push({time:time(),text});}
function rememberAccess(form){
 const key=form.dataset.accessKey;if(!key)return;
 const d=s.accessDrafts[key]||(s.accessDrafts[key]={}),v=new FormData(form);
 for(const [name,value] of v)if(name!=='allowed')d[name]=value;
 if(v.has('mode'))d.allowed=v.getAll('allowed');
 for(const el of form.querySelectorAll('[data-pool-model]'))d.states[el.dataset.poolModel]=el.value;
 for(const el of form.querySelectorAll('[data-pool-source]')){d.sources||={};d.sources[el.dataset.poolSource]=el.value;}
 return d;
}
function accessSubmit(form){
 const type=form.dataset.form;
 if(!['defaults','poolPreview','planCreate','memberOpen','projectCreate','projectApprove','projectRange'].includes(type))return false;
 const d=rememberAccess(form);
 if(type!=='projectCreate'&&s.role!=='ops'){fail('此操作由运营人员处理。');return true;}
 if(type==='defaults'){
  if(!s.pools[d.personal]||!s.pools[d.project]){fail('请选择有效默认池。');return true;}
  s.defaults={personal:d.personal,project:d.project};audit('更新默认模型池，仅影响后续新建。');notice='默认配置已保存；已有方案、项目与人员权限保持不变。';
 }else if(type==='poolPreview'){const reason=validatePoolDraft(d);if(reason){fail(reason);return true;}d.preview=true;}
 else if(type==='planCreate'){
  if(!d.name.trim()||!validRange(d)||!cents(d.amount)||!validDate(d.expiry)){fail('请填写方案名称、金额、有效期，指定模式至少选择一个已开放模型。');return true;}
  s.plans.push({id:'PLAN-'+s.seq++,name:d.name.trim(),pool:d.pool,mode:d.mode,allowed:copy(d.allowed),amount:cents(d.amount),cycle:d.cycle,expiry:d.expiry});
  delete s.accessDrafts.newPlan;s.nav='plans';notice='方案已保存，尚未向人员开通或发放。';
 }else if(type==='memberOpen'){
  const p=s.plans.find(p=>p.id===d.planId);if(!p||!live(p)){fail('请选择有效方案。');return true;}
  if(rights(s.memberId).some(e=>e.planId===p.id)){notice='该成员已开通此方案，未重复发放。';}
  else{const e=openEntitlement(s.memberId,p);s.wallets[s.memberId].general.push({id:'GENERAL-'+s.seq++,entitlementId:e.id,amount:p.amount,spent:0,expiry:p.expiry,pool:p.pool,source:p.name+' · 首次发放'});notice='已为 '+people[s.memberId]+' 开通 '+p.name+' 并发放 '+money(p.amount)+'。';audit(notice);}
 }else if(type==='projectCreate'){
  if(!d.name.trim()||!d.reason.trim()){fail('请填写项目名称与业务用途。');return true;}
  if(s.role==='ops'){
   if(!validRange(d)){fail('请选择有效模型范围；指定模式至少选择一个模型。');return true;}
   const p=createProject(d,'zhao');delete s.accessDrafts.newProject;s.nav='projects';notice=p.name+' 已创建。下一步发放项目总额度，再添加成员并分配。';
  }else{
   const duplicate=s.requests.find(r=>r.kind==='projectCreate'&&r.owner===actor()&&r.status==='pending'&&r.name===d.name.trim());
   if(duplicate){s.requestId=duplicate.id;notice='该项目申请已在审批中，未重复提交。';}
   else{const r={id:'REQ-'+s.seq++,kind:'projectCreate',scope:'',owner:actor(),name:d.name.trim(),scene:'创建项目',reason:d.reason.trim(),reviewer:'lin',status:'pending',submitted:time()};s.requests.push(r);s.requestId=r.id;notice='已送交运营，待确认模型范围。';}
   delete s.accessDrafts.projectApplication;s.nav='request';
  }
 }else if(type==='projectApprove'){
  const r=request();if(!r||r.kind!=='projectCreate'||r.status!=='pending'||r.reviewer!==actor()){fail('申请已处理或当前角色不能审批。');return true;}
  if(!validRange(d)){fail('请选择有效模型范围；指定模式至少选择一个模型。');return true;}
  const p=createProject(d,r.owner);Object.assign(r,{status:'approved',scope:p.id,processed:time(),comment:d.comment.trim()||'同意创建',range:{pool:p.pool,mode:p.mode,allowed:copy(p.allowed)}});notice='项目创建成功，尚无项目预算。';
 }else if(type==='projectRange'){
  if(!validRange(d)){fail('请选择有效模型范围。');return true;}d.preview=true;
 }
 render();return true;
}
function accessAction(action,b){
 if(action==='reset'){resetPending=true;notice='重置将清空本版模拟配置、申请与调用记录，并恢复初始示例。';render();return true;}
 if(action==='cancelReset'){resetPending=false;render();return true;}
 if(action==='confirmReset'){s=fresh();prompt='';rejecting=false;resetPending=false;render();return true;}
 if(action==='reapplyProject'){
  const r=request();if(!r||r.kind!=='projectCreate'||r.status!=='rejected'||r.owner!==actor())return true;
  s.accessDrafts.projectApplication={name:r.name,reason:r.reason};go('projectNew');return true;
 }
 const routes=['pools','plans','planNew','members','myProjects','projectNew','projectRange'];
 if(routes.includes(action)){
  if(action==='planNew')delete s.accessDrafts.newPlan;
  if(action==='projectNew')delete s.accessDrafts[s.role==='ops'?'newProject':'projectApplication'];
  if(action==='projectRange')delete s.accessDrafts['projectRange:'+s.project];
  if(action==='members'&&b.dataset.plan)s.accessDrafts.memberOpen={planId:b.dataset.plan};
  go(action);return true;
 }
 if(['confirmPool','cancelPool','confirmRange','rejectProject'].includes(action)){
  if(s.role!=='ops'){fail('此操作由运营人员处理。');return true;}
  if(action==='confirmPool'||action==='cancelPool'){
   const d=s.accessDrafts['pool:'+s.poolId];if(!d?.preview)return true;
   if(action==='confirmPool'){
    const p=s.pools[s.poolId],next=modelCatalog().filter(m=>d.states[m]==='open');
    const affected=poolImpact(s.poolId,next).filter(x=>x.added.length||x.removed.length);
    const reason=validatePoolDraft(d);if(reason){fail(reason);return true;}p.sources=copy(d.sources);p.models=next;p.staged=catalog.filter(m=>d.states[m]==='staged');audit(p.name+' 变更生效，影响 '+affected.length+' 项关联配置/权益。');notice='模型池变更已生效，跟随与指定模式分别更新；额度未变更。';
   }d.preview=false;
  }else if(action==='confirmRange'){
   const p=project(s.project),d=s.accessDrafts['projectRange:'+p.id];if(!d?.preview)return true;
   if(!validRange(d)){fail('范围已失效，请重新选择。');return true;}
   Object.assign(p,{pool:d.pool,mode:d.mode,allowed:copy(d.allowed)});audit(p.name+' 模型范围已调整，余额未改变。');delete s.accessDrafts['projectRange:'+p.id];s.nav='projects';notice='成员与该项目凭证已继承新范围。';
  }else{
   const r=request(),d=s.accessDrafts['projectReview:'+r?.id];if(!r||r.status!=='pending'||r.reviewer!==actor())return true;
   if(!d?.comment.trim()){fail('请在审批意见中填写驳回原因。');return true;}
   Object.assign(r,{status:'rejected',comment:d.comment.trim(),processed:time()});notice='项目创建申请已驳回。';
  }
  render();return true;
 }
 if(action==='fixture'){
  for(const [kind,scope,owner,amount] of [['general','general','chen',10000],['member','q4','chen',20000],['budget','q4','zhao',100000]]){
   if(pending(scope,owner,kind))continue;
   const r={id:'REQ-'+s.seq++,kind,scope,owner,amount,intent:'topup',reviewer:reviewer(kind,scope,owner),scene:'待审批演示',reason:'验证用途与审批职责',status:'pending',submitted:time()};s.requests.push(r);s.reviews[r.id]={amount:String(amount/100),expiry:'2026-12-31',grantId:'Q4-01',entitlementId:'E-CHEN',comment:'',rejectReason:''};
  }
  notice='已添加个人追加、项目成员和项目总额度待办；切换相应审批人处理。';render();return true;
 }
 return false;
}
function sourceCards(){
 return '<div class="quota-grid">'+scopes().map(id=>{
  const n=balance(id),st=usageState(id),wait=pending(id),active=current()===id,expires=wallet(id).filter(g=>live(g)&&g.amount>g.spent).map(g=>g.expiry).sort()[0];
  return '<article class="panel quota-card '+(active?"selected":"")+'" data-quota="'+id+'"><div class="head"><span class="quota-kind">'+(id==="general"?"个人 · 日常通用":"项目 · 成员额度")+'</span>'+tag(st.label,!st.canUse)+(wait?tag("申请待审批",true):"")+'</div><h2>'+esc(scopeName(id))+'</h2><p class="secondary">'+(id==="general"?"不需要加入项目，由企业方案或运营发放":"分配给 "+people[actor()]+"，只用于该项目")+'</p><strong class="quota-number">'+money(n)+'</strong><small class="secondary">用途余额'+(expires?" · 最近到期 "+expires:"")+'</small><div class="scope-meta"><span>审批人</span><b>'+reviewerName(reviewer(id==="general"?"general":"member",id,actor()))+'</b></div><div class="button-row">'+button("select","查看明细",false,'data-scope="'+id+'"')+nextAction(id,st)+(st.canUse?button(wait?"pending":"apply",wait?"查看申请进度":"申请追加",false,'data-scope="'+id+'"'):"")+'</div></article>';
 }).join("")+'</div>';
}
function pathBlock(id){
 const n=balance(id),p=project(id),wait=pending(id);
 return '<section class="panel"><div class="head"><h2>当前用途与扣费来源</h2>'+tag(id==="general"?"个人通用":"我的项目额度")+'</div><div class="path"><div class="node active"><small>'+(p?"归属项目":"发放来源")+'</small><b>'+esc(p?p.name:"企业员工方案 / 运营")+'</b><em>'+(p?"项目额度先分配给成员":"不依赖项目")+'</em></div><div class="arrow" aria-hidden="true">→</div><div class="node active"><small>使用者 · '+people[actor()]+'</small><b>'+esc(scopeName(id))+'</b><em>可用 '+money(n)+'</em></div><div class="arrow" aria-hidden="true">→</div><div class="node"><small>当前模型范围</small><b>'+poolIds(id).map(k=>s.pools[k].name).join("、")+'</b><em>'+models(id).join(" / ")+'</em></div></div><div class="notice">'+(wait?"该用途有申请待审批；原有可用额度仍可继续使用。":"在线使用与绑定此用途的个人密钥，共用这里的余额。")+' 余额不足时不会改扣其他用途。</div></section>';
}
function grantTable(id){
 const rows=wallet(id);
 return '<section class="panel"><div class="head"><h2>'+esc(scopeName(id))+' · 我的额度来源</h2><span>不同批次保留各自期限</span></div>'+(rows.length?'<div class="tablewrap"><table><thead><tr><th>来源 / 批次</th><th>授予金额</th><th>已消费</th><th>可用余额</th><th>到期日</th></tr></thead><tbody>'+rows.map(g=>'<tr><td>'+esc(g.source)+'<small>'+esc(g.id)+(g.grantId?" / "+esc(g.grantId):"")+'</small></td><td>'+money(g.amount)+'</td><td>'+money(g.spent)+'</td><td>'+money(live(g)?g.amount-g.spent:0)+'</td><td>'+g.expiry+(live(g)?"":" · 已过期")+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty">尚未获得这项用途的额度。加入项目不代表自动获得项目额度。</div>')+'</section>';
}
function home(){
 const id=current(),state=usageState(id),wait=pending(id),recent=ownRequests().slice().reverse().slice(0,3),others=scopes().filter(x=>x!==id);
 const expiry=wallet(id).filter(g=>live(g)&&g.amount>g.spent).map(g=>g.expiry).sort()[0];
 const awaiting=wait&&!state.canUse&&state.code!=='unavailable';
 const pendingText=wait?'<p class="pending-note">'+tag('申请待审批',true)+' 由 '+reviewerName(wait.reviewer)+' 处理'+(state.canUse?'，现有额度可继续使用。':'。')+'</p>':'';
 return '<section class="start-panel" data-state="'+state.code+'"><div class="start-body"><div><div class="start-context"><label for="deskScope">当前用途</label>'+scopeSelect('deskScope',id)+tag(state.label,!state.canUse)+'</div><h2>'+(awaiting?'申请已提交，等待审批':state.title)+'</h2><p>'+(awaiting?(wait.kind==='general'&&wait.intent==='access'?'运营审批通过后确认模型权限并发放额度。也可切换其他用途继续工作。':'审批通过后会更新此用途的额度，模型范围保持不变。也可切换其他用途继续工作。'):state.detail)+'</p><div class="model-line"><span>已开放模型</span>'+(state.available.slice(0,3).map(m=>'<span class="model-chip">'+esc(m)+'</span>').join('')||'<span>暂无</span>')+(state.available.length>3?button('models','查看全部 '+state.available.length+' 个'): '')+'</div>'+pendingText+'<div class="button-row">'+nextAction(id,state,true)+(state.canUse?button('deskCoding','接入编程工具',false,'data-scope="'+id+'"'):'')+'</div></div><div class="wallet-callout"><span>当前用途余额</span><strong>'+money(balance(id))+'</strong><p>按模型确认适用额度，不能跨方案借用。</p><p>'+(expiry?'最近一批于 '+expiry+' 到期':'尚无有效余额批次')+'</p>'+button('select','查看额度明细',false,'data-scope="'+id+'"')+'</div></div><div class="start-foot"><span>按当前用途扣费 · 不会自动改扣其他额度</span><button class="text-button" data-action="models">查看模型与权限 →</button></div></section>'+
 '<div class="desk-columns"><section class="panel"><div class="head"><h2>其他用途</h2><span>'+others.length+' 个项目 / 用途</span></div>'+others.map(x=>{const st=usageState(x),req=pending(x);return '<div class="desk-row" data-quota="'+x+'"><div class="row-copy"><b>'+esc(scopeName(x))+'</b><small>'+st.label+(req?' · 申请待审批':'')+'</small></div><span class="row-number">'+money(balance(x))+'</span>'+(st.canUse?button('deskSwitch','切换使用',false,'data-scope="'+x+'"'):nextAction(x,st))+'</div>';}).join('')+(others.length?'':'<div class="quiet-empty">你当前只使用个人通用额度，无需创建项目。</div>')+'<div class="section-note">项目额度只用于对应项目，个人通用使用不需要加入项目。</div></section><section class="panel"><div class="head"><h2>我的申请</h2><button class="text-button" data-nav="requests">查看全部 →</button></div>'+(recent.length?recent.map(r=>'<div class="activity-line"><span class="event-dot" aria-hidden="true"></span><p>'+esc(r.kind==='general'&&r.intent==='access'?'开通模型与额度':kindNames[r.kind])+'<small>'+esc(r.name||scopeName(r.scope))+' · '+(r.amount?money(r.amount):'项目创建')+'</small></p>'+button('request',labels[r.status],false,'data-id="'+r.id+'"')+'</div>').join(''):'<div class="quiet-empty"><b>暂时没有申请</b>已有额度可以直接使用。需要新模型时申请开通，金额不足时申请追加。</div>')+'<div class="mini-link"><span>当前用途 · '+esc(scopeName(id))+'</span>'+button(wait?'pending':state.code==='unopened'?'access':state.code==='unavailable'?'models':'apply',wait?'查看申请进度':state.code==='unopened'?'申请开通':state.code==='unavailable'?'查看模型范围':'申请 / 追加额度',false,'data-scope="'+id+'"')+'</div></section></div><div class="mini-link"><span>每次调用的用途、模型与费用都可追溯。</span><button class="text-button" data-nav="logs">查看我的调用日志 →</button></div>';
}

function deskOverview(){
 if(s.role!=='ops')return home();
 const tasks=myTasks().filter(r=>r.status==='pending'),finished=myTasks().filter(r=>r.status!=='pending'),personal=Object.values(s.wallets).flatMap(w=>w.general||[]).filter(live).reduce((n,g)=>n+g.amount-g.spent,0),projectFree=s.projects.reduce((n,p)=>n+grantOptions(p).reduce((a,g)=>a+remaining(p,g),0),0),cost=s.logs.reduce((n,l)=>n+l.cost,0);
 const stat=(label,value,detail)=>'<div class="ops-stat"><small>'+label+'</small><strong>'+value+'</strong><span class="detail">'+detail+'</span></div>';
 return onboardingGuide()+'<div class="ops-summary">'+stat('待我审批',tasks.length,'按当前运营职责汇总')+stat('个人有效余额',money(personal),'已发放，尚未消费')+stat('项目待分配',money(projectFree),'仍保留各批次有效期')+stat('本轮调用消费',money(cost),s.logs.length+' 次本地模拟调用')+'</div><div class="desk-columns"><div><section class="panel"><div class="head"><h2>需要你处理'+(tasks.length?' · '+tasks.length:'')+'</h2><button class="text-button" data-action="deskTodo">进入审批中心 →</button></div>'+(tasks.length?tasks.slice(0,5).map(r=>'<div class="desk-row"><div class="row-copy"><b>'+esc(r.kind==='general'?(r.intent==='access'?'个人模型开通':'个人额度追加'):kindNames[r.kind])+(r.scope==='general'?'':' · '+esc(r.name||scopeName(r.scope)))+'</b><small>'+people[r.owner]+' 发起 · '+esc(r.scene||r.reason||'待确认')+'</small></div>'+(r.amount?'<span class="row-number">'+money(r.amount)+'</span>':'')+button('request','处理',false,'data-id="'+r.id+'"')+'</div>').join(''):'<div class="quiet-empty"><b>待办已清空</b>员工和项目经理的新申请，会自动汇集到这里。</div>')+'<div class="queue-footer">批准前确认金额、有效期与可用模型，结果同步到申请人。</div></section><section class="panel"><div class="head"><h2>最近处理</h2><span>本轮操作</span></div>'+(finished.length?finished.slice(-3).reverse().map(r=>'<div class="activity-line"><span class="event-dot" aria-hidden="true"></span><p>'+people[r.owner]+' · '+esc(kindNames[r.kind])+'<small>'+esc(r.name||scopeName(r.scope))+' · '+esc(r.processed||'')+'</small></p>'+tag(labels[r.status],r.status==='rejected')+'</div>').join(''):'<div class="quiet-empty">处理申请后，这里会显示结果和时间。</div>')+'</section></div><div class="ops-side"><section class="panel"><div class="head"><h2>常用操作</h2><span>开通与配置</span></div><div class="quick-list"><button data-action="members"><span><b>为成员开通 AI</b><small>选择现有方案，一次完成开通与发放</small></span><span aria-hidden="true">↗</span></button><button data-action="projectNew"><span><b>创建项目</b><small>指定经理，预览可用模型</small></span><span aria-hidden="true">↗</span></button><button data-action="pools"><span><b>管理模型池</b><small>调整开放范围前，先查看影响</small></span><span aria-hidden="true">↗</span></button></div></section><section class="panel"><div class="head"><h2>资源与运行</h2>'+tag('运行数据未接入',true)+'</div><div class="resource-list"><div class="resource-line"><span>配置的模型池</span><b>'+Object.keys(s.pools).length+' 个</b></div><div class="resource-line"><span>个人开通方案</span><b>'+s.plans.length+' 个</b></div><div class="resource-line"><span>项目</span><b>'+s.projects.length+' 个</b></div><div class="resource-line"><span>上游故障率 / 活跃告警</span><b>— / —</b></div></div><div class="section-note">本方案未接入监控采集，不能据此判断服务健康。</div></section></div></div>';
}
function applicationForm(budget=false){
 const scope=budget?s.project:current(),kind=budget?"budget":scope==="general"?"general":"member",d=draft(),who=reviewer(kind,scope,actor()),existing=pending(scope,actor(),kind);
 if(existing){s.requestId=existing.id;return requestDetail();}
 if(budget&&!canManage(project(scope)))return '<section class="panel">无此项目管理权限。</section>';
 return '<section class="panel"><div class="head"><h2>'+ (budget?"申请项目总额度":kind==="general"?"申请个人通用额度":"申请项目成员额度")+'</h2>'+tag(budget?"进入项目，尚未分配给成员":kindNames[kind])+'</div><form data-form="'+(budget?"budget":"apply")+'" novalidate>'+
 (budget?'<p>项目：<b>'+esc(scopeName(scope))+'</b></p>':'<div class="field"><label for="applyScope">申请用途</label>'+scopeSelect("applyScope",scope)+'</div>')+
 (kind==='general'?'<div class="field"><label for="intent">申请事项</label><select id="intent" name="intent"><option value="topup" '+((d.intent|| (rights().length?'topup':'access'))!=='access'?'selected':'')+'>追加已有额度</option><option value="access" '+((d.intent|| (rights().length?'topup':'access'))==='access'?'selected':'')+'>开通模型与额度</option></select></div>':'')+'<div class="notice">审批人：<b>'+reviewerName(who)+'</b>。'+(budget?"批准后形成新的项目额度批次，成员个人余额不会自动增加。":kind==="general"?"首次开通由运营选择方案；追加额度沿用已有权益范围。":who==="lin"?"经理为自己申请成员额度，由运营审批。":"项目经理从已有批次分配，继承该批有效期。")+'</div><div class="field"><label for="amount">申请金额（元）</label><input id="amount" name="amount" inputmode="decimal" value="'+esc(d.amount)+'" required></div><div class="field"><label for="scene">使用场景</label><input id="scene" name="scene" maxlength="120" value="'+esc(d.scene)+'" required></div><div class="field"><label for="reason">使用说明</label><textarea id="reason" name="reason" maxlength="1000" required>'+esc(d.reason)+'</textarea></div><div class="button-row"><button type="submit" class="primary">提交申请</button>'+button(budget?"projects":"home","取消")+'</div></form></section>';
}
function summary(r){
 return '<dl class="facts">'+kv("申请单",esc(r.id))+kv("申请人",people[r.owner])+kv("事项",r.kind==="general"&&r.intent==="access"?"开通个人模型与额度":kindNames[r.kind])+kv("用途 / 对象",esc(scopeName(r.scope)))+kv("申请金额",money(r.amount))+kv("审批责任人",reviewerName(r.reviewer))+kv("使用场景",esc(r.scene))+kv("使用说明",esc(r.reason))+kv("提交时间",esc(r.submitted))+kv("状态",tag(labels[r.status],r.status==="pending"))+'</dl>';
}
function requestDetail(){
 const r=request();if(!related(r))return '<section class="panel">当前身份没有这笔申请的查看权限。</section>';
 if(r.kind==='projectCreate')return projectCreationReview(r);
 const editable=r.status==="pending"&&r.reviewer===actor();
 let h='<section class="panel"><div class="head"><h2>'+kindNames[r.kind]+'申请</h2>'+tag(labels[r.status],r.status==="pending")+'</div>'+summary(r);
 if(r.status!=="pending")h+='<div class="notice '+(r.status==="rejected"?"warn":"")+'">'+(r.status==="approved"?"批准 "+money(r.approved)+"，"+(r.kind==="budget"?"已发放到项目批次；尚未分配给个人。":"已发放到申请人的对应用途。"):"已驳回，未发放额度。")+'</div><dl class="facts">'+kv("处理意见",esc(r.comment))+kv("处理时间",esc(r.processed))+(r.status==="approved"?kv("来源批次",esc(r.grantId||r.walletId))+kv("有效至",r.expiry+" · 上海时间当日结束"):"")+'</dl>';
 if(r.owner===actor()){
  if(r.status==="pending") h+='<div class="notice warn">等待 '+reviewerName(r.reviewer)+' 处理。同用途无需重复提交，其他用途仍可使用或申请。</div><div class="demo-callout"><small>仅用于原型体验，切换审批人视角</small>'+button("reviewer","去审批方查看",false)+'</div>';
  else h+='<div class="button-row">'+(r.status==="rejected"?button("reapply","修改并重新申请",true):button(r.kind==="budget"?"projects":"use",r.kind==="budget"?"查看项目总额度":"使用此用途",true,'data-scope="'+r.scope+'"'))+'</div>';
 } else if(!editable)h+='<div class="button-row">'+button(r.owner==="chen"?"employee":"manager","切回申请人查看",true)+'</div>';
 h+='</section>';
 if(!editable)return h;
 const d=s.reviews[r.id],p=project(r.scope);
 h+='<div class="layout"><section class="panel"><div class="head"><h2>审批决定</h2><span>'+reviewerName(r.reviewer)+'</span></div>';
 if(rejecting)return h+'<form data-form="reject" novalidate><div class="field"><label for="rejectReason">驳回原因</label><textarea id="rejectReason" name="rejectReason" required>'+esc(d.rejectReason||"")+'</textarea></div><div class="button-row"><button class="danger-button" type="submit">确认驳回</button>'+button("cancelReject","返回审批")+'</div></form></section><aside class="panel"><h2>本次影响</h2><p class="secondary">只驳回本张申请，已有额度保持可用。</p></aside></div>';
 h+='<form data-form="approve" novalidate><div class="field"><label for="approvedAmount">批准金额（元）</label><input id="approvedAmount" name="amount" inputmode="decimal" value="'+esc(d.amount)+'"></div>';
 if(r.kind==="member"){
  const g=p.grants.find(x=>x.id===d.grantId);
  h+='<div class="field"><label for="grantId">项目来源批次</label><select id="grantId" name="grantId">'+grantOptions(p).map(g=>'<option value="'+g.id+'" '+(g.id===d.grantId?"selected":"")+'>'+g.id+' · 可分配 '+money(remaining(p,g))+' · '+g.expiry+' 到期</option>').join("")+'</select><small>单次从一批分配；不增加项目总预算。</small></div><div class="field"><label for="expiry">继承的有效期</label><input id="expiry" name="expiry" value="'+(g?.expiry||"无有效批次")+'" readonly></div>';
 }else{
  h+='<div class="field"><label for="expiry">有效期</label><input id="expiry" name="expiry" type="date" min="'+TODAY+'" max="2027-06-30" value="'+d.expiry+'"><small>到期当日结束失效（Asia/Shanghai）。</small></div>';
  if(r.kind==="general")h+=personalReview(r,d);
 }
 h+='<div class="field"><label for="comment">审批意见（选填）</label><textarea id="comment" name="comment">'+esc(d.comment)+'</textarea></div><div class="button-row"><button class="primary" type="submit">'+(r.kind==="budget"?"批准并发放到项目":"批准并发放额度")+'</button>'+button("reject","驳回申请")+'</div></form></section><aside class="panel"><h2>额度影响</h2>'+approvalPath(r,d)+'<p class="state-help">'+(r.kind==="general"?"只增加申请人的个人通用额度，保留新的来源批次和期限。":r.kind==="budget"?"只增加项目总额度和待分配余额，不会直接变成经理或员工个人可用额度。":"只增加申请人在 "+esc(p.name)+" 下的成员额度，并相应减少项目待分配余额。")+'</p>'+(r.kind==="member"?'<div class="balance-card"><small>项目有效待分配</small><strong>'+money(grantOptions(p).reduce((n,g)=>n+remaining(p,g),0))+'</strong></div>':"")+'<p class="secondary">批准与生效在本原型中同步模拟。</p></aside></div>';
 return h;
}
function requestList(approval=false){
 const source=approval?myTasks():ownRequests();
 const rows=source.filter(r=>!approval||(s.tab==="todo"?r.status==="pending":r.status!=="pending"));
 return '<section class="panel"><div class="head"><h2>'+(approval?"统一审批中心":"我发起的申请")+'</h2><span>按职责展示，同一申请共享结果</span></div>'+(approval?'<div class="tabs"><button class="ghost" data-tab="todo" aria-pressed="'+(s.tab==="todo")+'">待我审批 · '+source.filter(r=>r.status==="pending").length+'</button><button class="ghost" data-tab="done" aria-pressed="'+(s.tab==="done")+'">已处理</button></div>':"")+(rows.length?'<div class="tablewrap"><table><thead><tr><th>申请事项</th><th>金额</th><th>审批人</th><th>状态</th><th>操作</th></tr></thead><tbody>'+rows.slice().reverse().map(r=>'<tr><td><b>'+people[r.owner]+' · '+kindNames[r.kind]+'</b><small>'+esc(r.name||scopeName(r.scope))+' / '+r.id+'</small></td><td>'+(r.kind==='projectCreate'?'—':money(r.amount))+'</td><td>'+people[r.reviewer]+'</td><td>'+labels[r.status]+'</td><td>'+button("request",approval&&r.status==="pending"?"查看并审批":"查看进度",false,'data-id="'+r.id+'"')+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty">'+(approval?"当前没有相关待办。个人通用与项目总额度由运营处理；成员额度由项目经理处理，经理本人申请转运营。":"尚未发起申请。已有额度可以直接使用。")+'</div>')+'</section>';
}
function projectsView(){
 const available=s.projects.filter(canManage),p=project(s.project);
 if(!canManage(p))return '<section class="panel"><h2>项目管理</h2><p>当前没有可管理的项目。</p>'+(s.role==='ops'?button('projectNew','创建项目',true):'')+'</section>';
 const all=p.members.flatMap(u=>wallet(p.id,u)),grants=grantOptions(p);
 const total=p.grants.reduce((n,g)=>n+g.amount,0),spent=all.reduce((n,w)=>n+w.spent,0),free=grants.reduce((n,g)=>n+remaining(p,g),0),personal=all.filter(live).reduce((n,w)=>n+w.amount-w.spent,0);
 return (s.role==='ops'?'<div class="button-row page-tools">'+button('projectNew','创建项目',true)+'</div>':'')+'<section class="panel"><div class="head"><h2>模型与使用范围</h2>'+(s.role==='ops'?button('projectRange','调整模型范围'):'<span>由运营配置，所有成员继承</span>')+'</div>'+rangeSummary(p)+'</section><section class="panel"><div class="head"><h2>项目总额度与成员分配</h2><span>管理视角</span></div><div class="field"><label for="projectPicker">管理项目</label><select id="projectPicker">'+available.map(x=>'<option value="'+x.id+'" '+(x.id===p.id?"selected":"")+'>'+esc(x.name)+'</option>').join("")+'</select></div><div class="project-metrics">'+[["累计发放",total],["已消费",spent],["有效待分配",free],["成员有效余额",personal]].map(([title,n])=>'<div class="balance-card"><small>'+title+'</small><strong>'+money(n)+'</strong></div>').join("")+'</div><div class="notice">项目总额度先进入项目，再分配给成员。分配不是消费，项目总额度也不是经理个人余额。</div><div class="button-row">'+(s.role==="manager"?button("budgetApply","为项目申请总额度",true):"")+(s.role==="ops"?button("projectGrant","发放项目总额度",true):"")+button("projectMembers","添加成员")+button("allocate","分配给成员")+'</div></section><section class="panel"><h2>项目额度批次</h2><div class="tablewrap"><table><thead><tr><th>批次</th><th>发放金额</th><th>待分配</th><th>有效至</th></tr></thead><tbody>'+p.grants.map(g=>'<tr><td>'+g.id+'<small>'+esc(g.source)+'</small></td><td>'+money(g.amount)+'</td><td>'+money(live(g)?remaining(p,g):0)+'</td><td>'+g.expiry+'</td></tr>').join("")+'</tbody></table></div></section><section class="panel"><h2>成员在本项目中的额度</h2><div class="tablewrap"><table><thead><tr><th>成员</th><th>当前可用</th><th>已消费</th><th>操作</th></tr></thead><tbody>'+p.members.map(u=>'<tr><td>'+people[u]+(u===p.manager?" · 经理":"")+'</td><td>'+money(balance(p.id,u))+'</td><td>'+money(wallet(p.id,u).reduce((n,w)=>n+w.spent,0))+'</td><td>'+button("allocate","分配额度",false,'data-member="'+u+'"')+'</td></tr>').join("")+'</tbody></table></div></section>';
}
function allocateView(){
 const p=project(s.project);if(!canManage(p))return '<section class="panel">无此项目管理权限。</section>';
 const d=draft();
 if(!d.grantId)d.grantId=grantOptions(p).find(g=>remaining(p,g)>0)?.id||"";
 const g=p.grants.find(x=>x.id===d.grantId);
 return '<section class="panel"><h2>从 '+esc(p.name)+' 分配给成员</h2><form data-form="allocate" novalidate><div class="field"><label for="member">成员</label><select id="member" name="member">'+p.members.map(u=>'<option value="'+u+'" '+(u===d.member?"selected":"")+'>'+people[u]+'</option>').join("")+'</select></div><div class="field"><label for="directGrant">来源批次</label><select id="directGrant" name="grantId">'+grantOptions(p).map(x=>'<option value="'+x.id+'" '+(x.id===d.grantId?"selected":"")+'>'+x.id+' · 可分配 '+money(remaining(p,x))+'</option>').join("")+'</select></div><div class="field"><label for="amount">分配金额（元）</label><input id="amount" name="amount" value="'+esc(d.amount)+'" inputmode="decimal"></div><div class="notice">有效期继承 '+(g?.expiry||"所选批次")+'。分配后仅增加该成员在本项目下的额度。</div><div class="button-row"><button class="primary" type="submit">确认分配</button>'+button("projects","返回项目")+'</div></form></section>';
}
function useView(){
 const key=s.keys.find(k=>k.id===s.keyId&&k.owner===actor()),scope=key?key.scope:current(),list=models(scope);
 if(!s.model)s.model=list.find(m=>usageState(scope,m).canUse)||list[0]||"";
 const state=usageState(scope,s.model),stale=s.model&&!list.includes(s.model);
 const options=(stale?'<option value="'+esc(s.model)+'" selected>'+esc(s.model)+' · 当前不可用</option>':'')+list.map(m=>'<option value="'+esc(m)+'" '+(m===s.model?'selected':'')+'>'+esc(m)+'</option>').join('');
 return '<section class="panel"><div class="head"><h2>'+(key?'模拟个人密钥接入':'在线使用')+'</h2>'+tag(state.label,!state.canUse)+'</div><form data-form="send" novalidate><div class="use-context"><div class="field"><label for="useScope">本次扣费用途</label>'+scopeSelect('useScope',scope)+'</div><div class="balance-card model-funds"><small>该模型适用余额</small><strong id="modelBalance">'+money(state.amount)+'</strong><div class="secondary">只累计授权与资金来源匹配的有效批次</div></div></div>'+(key?'<p class="state-help">演示凭证 '+esc(key.name)+' 固定绑定 '+esc(scopeName(key.scope))+'，切换用途需使用另一把凭证。</p>':'')+'<div class="field"><label for="model">本次使用模型</label><select id="model" name="model" '+(!options?'disabled':'')+'>'+ (options||'<option value="">暂无已开放模型</option>')+'</select></div>'+
 '<details class="fund-details"><summary>查看该模型的 '+state.grants.length+' 个适用额度批次</summary>'+(state.grants.length?'<div class="tablewrap"><table><thead><tr><th>来源 / 批次</th><th>剩余额度</th><th>到期日</th></tr></thead><tbody>'+state.grants.map(g=>'<tr><td>'+esc(g.source)+'<small>'+esc(g.id)+'</small></td><td>'+money(Math.max(0,g.amount-g.spent))+'</td><td>'+esc(g.expiry)+'</td></tr>').join('')+'</tbody></table></div>':'<p class="state-help">没有匹配的有效额度批次。用途内其他方案的余额不会借用于此模型。</p>')+'</details>'+
 '<div class="notice '+(state.canUse?'':'warn')+'" data-state="'+state.code+'">'+(state.canUse?'当前扣费：'+esc(scopeName(scope))+'。':state.detail)+' 不会自动借用其他方案或用途的余额。</div><div class="field"><label for="prompt">输入问题</label><textarea id="prompt" name="prompt" placeholder="例如：帮我整理一份研发周报提纲。">'+esc(prompt)+'</textarea><small>本地模拟回复，每次成功扣 ¥ 0.02，不发送到真实网关。</small></div><div class="button-row"><button class="'+(state.canUse?'primary':'ghost')+'" type="submit" '+(state.canUse?'':'disabled')+'>发送请求</button>'+(state.canUse?button(pending(scope)?'pending':'apply',pending(scope)?'查看申请进度':'申请追加额度',false,'data-scope="'+scope+'"'):nextAction(scope,state,true))+'</div></form></section>';
}
function modelsView(){
 const scope=current(),state=usageState(scope);
 return '<section class="panel"><div class="head"><h2>按用途查看模型</h2>'+tag(state.label,!state.canUse)+'</div><div class="field"><label for="modelScope">用途</label>'+scopeSelect('modelScope',scope)+'</div>'+(state.available.length?state.available.map(m=>{const st=usageState(scope,m);return '<div class="desk-row"><div class="row-copy"><b>'+esc(m)+'</b><small>'+st.label+' · 适用余额 '+money(st.amount)+'</small></div>'+button('use','查看并使用',false,'data-scope="'+scope+'" data-model="'+esc(m)+'"')+'</div>';}).join(''):'<div class="notice warn">'+state.detail+'</div>'+nextAction(scope,{...state,action:state.code==='unopened'?'access':'home',actionLabel:state.code==='unopened'?'申请开通模型与额度':'返回工作台'}))+'</section>'+pathBlock(scope)+'<section class="panel"><h2>模型权限来源</h2>'+(scope==='general'?personalRights(actor()):rangeSummary(project(scope)))+'<p class="state-help">个人开通与项目模型范围由运营维护。项目成员继承项目范围，申请追加额度不会改变模型权限。</p></section>';
}
function approvalPath(r,d){
 const source=r.kind==='general'?(r.intent==='access'?s.plans.find(p=>p.id===d.planId)?.name:s.entitlements.find(e=>e.id===d.entitlementId)?.name)||'运营确认的个人方案':r.kind==='member'?scopeName(r.scope)+' / '+(d.grantId||'待选择批次'):'运营发放新批次';
 const target=r.kind==='budget'?scopeName(r.scope)+' · 项目待分配额度':people[r.owner]+' · '+(r.scope==='general'?'个人通用额度':scopeName(r.scope)+' · 项目成员额度');
 return '<div class="flow-node"><small>额度来源</small><b>'+esc(source)+'</b></div><div class="flow-arrow" aria-hidden="true">↓</div><div class="flow-node"><small>本次发放至</small><b>'+esc(target)+'</b></div>';
}

function keysView(){
 return '<section class="panel"><div class="head"><h2>个人凭证与用途</h2>'+tag("仅演示元数据")+'</div><div class="field"><label for="keyScope">新凭证绑定用途</label>'+scopeSelect("keyScope",current())+'</div><p class="secondary">凭证不拥有独立余额；绑定个人通用或某个项目用途，与在线使用共享该用途的额度。此页不签发真实密钥。</p><form data-form="key" novalidate><div class="field"><label for="keyName">名称</label><input id="keyName" name="name" value="我的代码助手" maxlength="80"></div><button class="primary" type="submit">添加演示凭证</button></form></section><section class="panel"><h2>我的演示凭证</h2>'+s.keys.filter(k=>k.owner===actor()).map(k=>'<div class="key-row"><div><b>'+esc(k.name)+'</b><small>'+k.id+' · '+esc(scopeName(k.scope))+' · 无真实密钥</small></div>'+button("keyUse","模拟接入",false,'data-id="'+k.id+'"')+'</div>').join("")+(s.keys.some(k=>k.owner===actor())?"":'<div class="empty">尚未添加凭证，在线使用不需要个人密钥。</div>')+'</section>';
}
function logsView(){
 const rows=s.logs.filter(x=>x.owner===actor()&&(s.logFilter==="all"||x.scope===s.logFilter));
 return '<section class="panel"><div class="head"><h2>我的调用日志</h2><span>请求使用哪个用途，就记在哪个用途</span></div><div class="field"><label for="logScope">用途筛选</label>'+scopeSelect("logScope",s.logFilter,true)+'</div>'+(rows.length?'<div class="tablewrap"><table><thead><tr><th>请求 / 模型</th><th>扣费用途</th><th>来源批次</th><th>结果 / 费用</th></tr></thead><tbody>'+rows.map(l=>'<tr><td><b>'+esc(l.model)+'</b><small>'+l.id+' · '+l.time+'</small><small>'+esc(l.serviceName||'历史记录未记录服务来源')+' / '+esc(l.upstreamModel||'—')+'</small><small>'+(l.keyId?"演示凭证 "+l.keyId:"在线使用")+'</small></td><td>'+esc(scopeName(l.scope))+'</td><td>'+esc(l.grantId)+'</td><td>本地模拟成功<small>'+money(l.cost)+'</small></td></tr>').join("")+'</tbody></table></div>':'<div class="empty">当前用途筛选下还没有调用记录。</div>')+'</section>';
}
function resultView(){
 const l=s.logs.find(x=>x.id===s.resultId&&x.owner===actor());if(!l)return logsView();
 return '<section class="panel"><div class="head"><h2>调用完成</h2>'+tag("本地模拟成功")+'</div><div class="notice">扣费 '+money(l.cost)+'，来源：<b>'+esc(scopeName(l.scope))+'</b>。当前该用途剩余 '+money(balance(l.scope))+'。</div><p class="secondary">演示回复：周报可以按本周进展、风险与阻塞、下周计划组织，并给出每项工作的负责人。</p><dl class="facts">'+kv("请求",l.id)+kv("模型",esc(l.model))+kv("模型池",esc(l.poolName||'历史记录未记录'))+kv("服务来源",esc(l.serviceName||'历史记录未记录'))+kv("上游模型标识",esc(l.upstreamModel||'—'))+kv("额度批次",l.grantId)+kv("用量（演示）","1,240 input / 386 output tokens")+'</dl><div class="button-row">'+button("logs","查看日志",true)+button("use","继续使用",false,'data-scope="'+l.scope+'"')+'</div></section>';
}
function body(){
 const resource=resourceView();if(resource!==null)return resource;
 const extended=accessView();if(extended!==null)return extended;
 switch(s.nav){
 case "overview":return deskOverview();
 case "home":return home();
 case "quota":return sourceCards()+pathBlock(current())+grantTable(current());
 case "apply":return applicationForm();
 case "budgetApply":return applicationForm(true);
 case "request":return requestDetail();
 case "requests":return requestList();
 case "approvals":return requestList(true);
 case "projects":return projectsView();
 case "allocate":return allocateView();
 case "use":return useView();
 case "keys":return keysView();
 case "logs":return logsView();
 case "result":return resultView();
 case "models":return modelsView();
 default:return home();
 }
}
function render(){
 initResources();
 const ops=s.role==="ops";
 const focus=document.activeElement,restore=focus?.closest('#content')&&['INPUT','SELECT','TEXTAREA'].includes(focus.tagName)?{id:focus.id,name:focus.name,value:focus.value}:null;
 document.querySelector('.nav').setAttribute('aria-label','主导航');
 document.querySelectorAll("[data-role]").forEach(b=>{const selected=b.dataset.role===s.role;b.classList.toggle("active",selected);b.setAttribute("aria-pressed",String(selected));});
 document.querySelector(".brand span").textContent=ops?"运营控制台":s.role==="manager"?"个人空间与项目管理":"员工工作台";
 document.querySelector(".avatar").textContent=people[actor()][0];
 document.querySelector(".avatar").setAttribute("aria-label",roleNames[s.role]);
 document.querySelector(".rail-note").innerHTML="<strong>"+roleNames[s.role]+"</strong>"+(ops?"通用额度、项目总额度和经理本人申请":s.role==="manager"?"管理职责与个人使用额度分别展示":"个人通用 + "+s.projects.filter(p=>p.members.includes(actor())).length+" 个项目用途");
 let navs=ops?[]:[["home","⌂","我的工作台"],["use","▷","在线使用"],["keys","⌘","接入与密钥"],["quota","◒","我的额度"],["models","◈","可用模型"],["requests","⌁","我发起的申请"],["logs","≋","我的调用日志"]];
 if(s.role!=="employee")navs.push(["projects","▦","项目管理"],["approvals","⌁","审批中心"]);
 if(ops)navs.unshift(['overview','⌂','运营总览'],['services','◈','模型'],['plans','◒','开通与发放'],['members','◇','组织与成员']);
 else navs.push(['myProjects','▦','我的项目']);
 const groups=ops?{overview:'工作空间',services:'资源与开通',projects:'业务管理'}:{home:'工作空间',quota:'额度与记录',projects:'项目管理',myProjects:'项目协作'};
 document.querySelector(".nav").innerHTML=navs.map(([id,icon,label])=>(groups[id]?'<div class="nav-label">'+groups[id]+'</div>':'')+'<button data-nav="'+id+'" '+((id===s.nav||(id==='services'&&['catalog','pools','poolNew','definitionNew','serviceEdit'].includes(s.nav)))?'aria-current="page" class="active"':"")+'><i aria-hidden="true">'+icon+'</i>'+label+(id==='approvals'&&myTasks().some(r=>r.status==='pending')?'<span class="nav-count">'+myTasks().filter(r=>r.status==='pending').length+'</span>':'')+'</button>').join("");
 const titles={home:"一处查看，按用途使用",quota:"我的额度",apply:"申请额度",budgetApply:"申请项目总额度",request:"申请详情",requests:"我发起的申请",approvals:"审批中心",projects:"项目总额度与成员分配",allocate:"分配成员额度",use:"在线使用",keys:"接入与密钥",logs:"我的调用日志",result:"调用完成",models:"可用模型"};
 Object.assign(titles,{services:'模型服务',catalog:'模型目录',serviceEdit:'接入与验证模型服务',definitionNew:'新建模型定义',poolNew:'新建用途模型池',projectGrant:'发放项目总额度',projectMembers:'添加项目成员',home:'你好，'+people[actor()],overview:'运营总览',pools:'模型池与默认配置',plans:'个人开通方案',planNew:'新建个人开通方案',members:'成员 AI 使用权益',myProjects:'我的项目',projectNew:s.role==='ops'?'创建项目':'申请创建项目',projectRange:'项目模型范围'});
 document.getElementById("title").textContent=titles[s.nav]||"我的工作台";
 document.getElementById("crumb").textContent=s.nav==='home'?'我的工作台':titles[s.nav]||'我的工作台';
 const subtitles={home:'选择用途，开始今天的 AI 工作。',overview:'处理开通与额度申请，掌握资源的分配去向。',pools:'按用途组织模型，变更前确认开放范围与影响。',plans:'把模型范围与额度规则保存为可复用方案。',members:'为成员选择方案，查看实际获得的资源。',apply:'说明使用需求，由对应负责人确认额度与权限。',approvals:'申请统一汇集，按你的职责处理。',projects:'管理项目预算、有效批次和成员分配。',keys:'凭证固定绑定一个用途，与在线使用共享额度。',use:'先确认扣费用途和模型，再发送消息。'};
 document.getElementById("subtitle").textContent=subtitles[s.nav]||'查看当前范围与状态，继续完成操作。';
 const main=document.getElementById("mainAction");main.hidden=!['overview','quota'].includes(s.nav);main.textContent=s.nav==='overview'?'为成员开通 AI':'申请额度';main.dataset.action=s.nav==='overview'?'members':'apply';delete main.dataset.scope;
 document.querySelector(".stepper").hidden=true;
 document.getElementById("content").innerHTML=body();
 if(restore&&!error){const target=restore.id?document.getElementById(restore.id):[...document.querySelectorAll('#content input')].find(el=>el.name===restore.name&&el.value===restore.value);target?.focus({preventScroll:true});}
 if(s.nav==="use"&&s.keyId){const select=document.getElementById("useScope");if(select)select.disabled=true;}
 const e=document.getElementById("error");e.textContent=error;e.hidden=!error;
 document.getElementById("feedback").textContent=notice;document.getElementById("feedback").hidden=!notice;
 if(resetPending){const feedback=document.getElementById('feedback');feedback.hidden=false;feedback.innerHTML='重置将清空本版模拟配置、申请与调用记录，并恢复初始示例。<div class="button-row">'+button('confirmReset','确认重置演示')+button('cancelReset','保留当前数据')+'</div>';}
 if(error)e.focus();
 save();
}
function newRequest(kind,scope){
 const d=draft(),n=cents(d.amount),owner=actor();
 if(kind==="budget"?s.role!=="manager"||!canManage(project(scope)):s.role==="ops"||!scopes().includes(scope))return fail("当前身份不能提交此类申请。");
 const wait=pending(scope,owner,kind);if(wait){s.requestId=wait.id;s.nav="request";notice="已有同用途待审批申请，未重复提交。";return render();}
 if(n===null)return fail("请输入大于零、最多两位小数的金额。");
 if(!d.scene.trim()||!d.reason.trim())return fail("请填写使用场景和说明。");
 const r={id:"REQ-"+s.seq++,kind,scope,owner,intent:d.intent||(rights(owner).length?'topup':'access'),reviewer:reviewer(kind,scope,owner),amount:n,scene:d.scene.trim(),reason:d.reason.trim(),status:"pending",submitted:time()};
 s.requests.push(r);s.requestId=r.id;
 const p=project(scope),g=p?grantOptions(p).find(x=>remaining(p,x)>=n)||grantOptions(p)[0]:null;
 s.reviews[r.id]={amount:(n/100).toFixed(2),expiry:g?.expiry||"2026-12-31",pool:"office",grantId:g?.id||"",comment:"",rejectReason:""};
 s.nav="request";notice="申请已提交给 "+reviewerName(r.reviewer)+"。";render();
}
function addMember(p,user,g,n,source){
 const w={id:"MEMBER-"+s.seq++,amount:n,spent:0,expiry:g.expiry,pool:p.pool,grantId:g.id,source};
 s.wallets[user][p.id].push(w);return w;
}
function decide(approved){
 const r=request();if(!r||r.reviewer!==actor())return fail("当前角色不是该申请的审批责任人。");
 if(r.status!=="pending")return fail("该申请已处理，未重复发放。");
 const d=s.reviews[r.id];
 if(!approved){
  if(!d.rejectReason.trim())return fail("请填写驳回原因。");
  r.status="rejected";r.comment=d.rejectReason.trim();
 }else{
  const n=cents(d.amount);if(n===null)return fail("批准金额必须大于零，且最多两位小数。");
  const p=project(r.scope);let w;
  if(r.kind==="member"){
   const g=p.grants.find(g=>g.id===d.grantId&&live(g));
   if(!g||n>remaining(p,g))return fail("所选项目批次余额不足，请调整金额或选择另一有效批次。");
   w=addMember(p,r.owner,g,n,"申请批准 · "+r.id);r.grantId=g.id;r.expiry=g.expiry;r.walletId=w.id;
  }else{
   if(!validDate(d.expiry))return fail("请选择有效日期，范围为演示日期至 2027-06-30。");
   r.expiry=d.expiry;
   if(r.kind==="budget"){
    const g={id:"PROJECT-"+s.seq++,amount:n,expiry:d.expiry,source:"项目总额度申请 · "+r.id};
    p.grants.push(g);r.grantId=g.id;
   }else{
    const pl=s.plans.find(p=>p.id===d.planId);
    let ent=r.intent==='access'?rights(r.owner).find(e=>e.planId===d.planId):rights(r.owner).find(e=>e.id===d.entitlementId);
    if(r.intent==='access'&&(!pl||!live(pl)))return fail('请选择有效个人开通方案。');
    if(r.intent!=='access'&&!ent)return fail('请先开通模型权限，本次追加不能创建新授权。');
    if(d.expiry>(ent?.expiry||pl.expiry))return fail('额度有效期不能超过所选权益有效期。');
    if(!ent)ent=openEntitlement(r.owner,pl);
    w={id:"GENERAL-"+s.seq++,entitlementId:ent.id,amount:n,spent:0,expiry:d.expiry,pool:ent.pool,source:"通用额度申请 · "+r.id};
    s.wallets[r.owner].general.push(w);r.walletId=w.id;
   }
  }
  r.approved=n;r.status="approved";r.comment=d.comment.trim()||"同意按申请用途使用。";
 }
 r.processed=time();rejecting=false;notice=approved?"审批已生效，可切回申请人查看对应用途。":"已驳回，原有额度未受影响。";render();
}
function send(form){
 const key=s.keys.find(k=>k.id===s.keyId&&k.owner===actor()),scope=key?key.scope:current();
 if(s.role==="ops"||!scopes().includes(scope))return fail("当前身份没有该用途的使用权限。");
 prompt=form.prompt||"";
 if(!prompt.trim())return fail("请输入问题。");
 const model=form.model||s.model,state=usageState(scope,model);
 if(!models(scope).includes(model))return fail(state.detail);
 const g=wallet(scope).filter(w=>live(w)&&quotaSupports(w,scope,model)&&w.amount-w.spent>=2).sort((a,b)=>a.expiry.localeCompare(b.expiry))[0];
 if(!g)return fail("当前用途没有足够的单笔适用额度。未调用、未扣费，也不会自动借用其他用途。");
 const poolId=scope==='general'?rights().find(e=>e.id===g.entitlementId).pool:project(scope).pool;
 const service=serviceById(s.pools[poolId].sources[model]),definition=s.definitions.find(d=>d.name===model);
 g.spent+=2;
 const l={id:"CALL-"+s.seq++,owner:actor(),scope,grantId:g.id,projectGrant:g.grantId||"",cost:2,model,poolId,poolName:s.pools[poolId].name,serviceId:service.id,serviceName:service.name,upstreamModel:service.models.find(m=>m.definition===definition.id).upstream,time:time(),keyId:key?.id||""};
 s.logs.unshift(l);s.resultId=l.id;s.nav="result";prompt="";render();
}
document.addEventListener("input",e=>{
 const form=e.target.closest("form[data-form]");if(!form)return;
 if(form.dataset.resourceKey){const d=resourceRemember(form);if(d)d.preview=false;save();return;}
 if(form.dataset.accessKey){rememberAccess(form);save();return;}
 const name=e.target.name,v=e.target.value,kind=form.dataset.form;
 if(["apply","budget","allocate"].includes(kind)&&["amount","scene","reason","member","grantId","intent"].includes(name))draft()[name]=v;
 if(kind==="approve"&&s.reviews[s.requestId])s.reviews[s.requestId][name]=v;
 if(kind==="reject")s.reviews[s.requestId].rejectReason=v;
 if(kind==="send"&&name==="prompt")prompt=v;
 save();
});
document.addEventListener("change",e=>{
 const t=e.target;
 const resource=t.closest('form[data-resource-key]');
 if(resource){const d=resourceRemember(resource);if(!d)return;d.preview=false;
  if(t.dataset.serviceDefinition){const id=t.dataset.serviceDefinition;d.models=d.models.filter(m=>m.definition!==id);if(t.checked)d.models.push({definition:id,upstream:s.definitions.find(x=>x.id===id).alias});d.check={status:'untested'};}
  if(t.name==='scenario')d.check={status:'untested'};
  if(t.tagName==='SELECT'||t.type==='checkbox')render();else save();return;
 }
 const form=t.closest('form[data-access-key]');
 if(form){
  const d=rememberAccess(form);if(t.name==='pool')d.allowed=[];d.preview=false;
  if(t.tagName==='SELECT'||['radio','checkbox'].includes(t.type))render();else save();return;
 }
 if(t.id==='poolPicker'){s.poolId=t.value;render();return;}
 if(t.id==='memberPicker'){s.memberId=t.value;render();return;}
 if(t.id==='reviewBinding'){s.reviews[s.requestId][t.name]=t.value;render();return;}
 if(t.id==='deskScope'){selectedScope(t.value);error='';notice='';render();return;}
 if(t.id==='intent'){draft().intent=t.value;save();return;}
 if(["applyScope","useScope","keyScope","modelScope"].includes(t.id)){
  if(t.id==="useScope"&&s.keyId)return;
  selectedScope(t.value);error="";notice="";render();
 }else if(t.id==="projectPicker"){s.project=t.value;render();}
 else if(t.id==="grantId"){s.reviews[s.requestId].grantId=t.value;render();}
 else if(t.id==="directGrant"){draft().grantId=t.value;render();}
 else if(t.id==="logScope"){s.logFilter=t.value;render();}
 else if(t.id==="model"){s.model=t.value;render();}
});
document.addEventListener("submit",e=>{
 const form=e.target.closest("form[data-form]");if(!form)return;e.preventDefault();error="";notice="";
 if(resourceSubmit(form))return;
 if(accessSubmit(form))return;
 const values=Object.fromEntries(new FormData(form));
 switch(form.dataset.form){
 case "apply":Object.assign(draft(),values);newRequest(current()==="general"?"general":"member",current());break;
 case "budget":Object.assign(draft(),values);newRequest("budget",s.project);break;
 case "approve":Object.assign(s.reviews[s.requestId],values);decide(true);break;
 case "reject":Object.assign(s.reviews[s.requestId],values);decide(false);break;
 case "allocate":{
  const p=project(s.project),n=cents(values.amount),g=p?.grants.find(x=>x.id===values.grantId&&live(x));
  Object.assign(draft(),values);
  if(!canManage(p)||!p.members.includes(values.member))return fail("请选择有权分配的项目成员。");
  if(n===null||!g||remaining(p,g)<n)return fail("金额无效或来源批次可分配余额不足。");
  addMember(p,values.member,g,n,"直接分配 · "+people[actor()]);s.nav="projects";notice="已分配 "+money(n)+" 给 "+people[values.member]+"，仅在该项目下可用。";render();break;
 }
 case "send":send(values);break;
 case "key":
  if(s.role==="ops"||balance(current())<=0)return fail("请先获得该用途的可用额度。");
  if(!values.name?.trim())return fail("请填写名称。");
  s.keys.push({id:"DEMO-"+s.seq++,owner:actor(),scope:current(),name:values.name.trim()});notice="已添加用途绑定的演示凭证；未签发真实密钥。";render();break;
 }
});
document.addEventListener("click",e=>{
 const b=e.target.closest("button");if(!b||b.disabled)return;
 if(b.dataset.role){switchRole(b.dataset.role);return;}
 if(b.dataset.nav){if(b.dataset.nav==="use"){s.keyId="";s.model="";}go(b.dataset.nav);return;}
 if(b.dataset.tab){s.tab=b.dataset.tab;render();return;}
 const action=b.dataset.action;if(!action)return;error="";notice="";
 if(resourceAction(action,b))return;
 if(accessAction(action,b))return;
 if(b.dataset.project)s.project=b.dataset.project;
 if(b.dataset.scope)selectedScope(b.dataset.scope);
 switch(action){
 case 'deskSwitch':go('home');return;
 case 'deskCoding':go('keys');return;
 case 'deskTodo':s.tab='todo';go('approvals');return;
 case 'models':go('models');return;
 case 'access':s.nav='apply';draft().intent='access';render();return;
 case "select":go("quota");return;
 case "home":case "projects":case "logs":go(action);return;
 case "apply":go("apply");return;
 case "use":s.keyId="";s.model=b.dataset.model||"";go("use");return;
 case "pending":{const r=pending(current());if(r){s.requestId=r.id;go("request");}return;}
 case "request":s.requestId=b.dataset.id;go("request");return;
 case "reviewer":{const r=request();if(r){const id=r.id;switchRole(r.reviewer==="lin"?"ops":"manager");s.requestId=id;go("request");}return;}
 case "employee":case "manager":switchRole(action);return;
 case "budgetApply":go("budgetApply");return;
 case "allocate":s.nav="allocate";if(b.dataset.member)draft().member=b.dataset.member;render();return;
 case "reject":if(request()?.reviewer===actor()){rejecting=true;render();}return;
 case "cancelReject":rejecting=false;render();return;
 case "reapply":{
  const r=request();if(!r||r.owner!==actor()||r.status!=="rejected")return;
  if(r.kind==="budget"){s.project=r.scope;s.nav="budgetApply";}else{selectedScope(r.scope);s.nav="apply";}
  Object.assign(draft(),{amount:(r.amount/100).toFixed(2),scene:r.scene,reason:r.reason});render();return;
 }
 case "keyUse":{const k=s.keys.find(k=>k.id===b.dataset.id&&k.owner===actor());if(k){selectedScope(k.scope);s.keyId=k.id;s.model="";go("use");}return;}
 }
});
render();
})();
