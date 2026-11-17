import {hasPermission,ROLE_LABELS,ALERT_METRICS,type PublicUpstreamCredential,type WebhookChannel} from '@ai-gateway/contracts';
import { QUOTA_FOREVER, isPermanentQuota, applicationBillingMode, parseMemberImport, MODEL_CAPABILITIES, MODEL_KINDS, METER_UNITS, ROUTING_STRATEGIES, modelProviders, BUILTIN_PROVIDERS, type ModelProvider, type AlertRule, type AutoRule, type Application, type ApprovalKind, type CallLog, type Entitlement, type ModelDefinition, type ModelPool, type ModelService, type Plan, type PlatformSnapshot, type Project } from '@ai-gateway/contracts';
import { date,endOfDay, toDateInput, type Editor, type FieldSpec, type FormValues, type RelatedResource } from './components';
import { limitFields,limitInitial,readLimits } from './limit-fields';
import { organizationPath,organizationTree } from './organizations';
import {approvalFormContext,approvalLabels} from './approval-presentation';
import {availablePlanModels} from './model-readiness';
import {memberLabel} from './person-identity';
import type {PersonScope} from '@ai-gateway/contracts';

export type RunCommand=(type:string,payload:Record<string,unknown>,confirm?:boolean)=>Promise<unknown|null>;
const option=(id:string,name:string)=>({value:id,label:name});
const values=(value:string|string[]|undefined)=>Array.isArray(value)?value:[];
function readCostPrice(v:FormValues,definitionId:string){
  const keys=['inputPrice','outputPrice','cachedInputPrice'] as const,raw=keys.map(kind=>v[`cost:${kind}:${definitionId}`]);
  if(raw.every(value=>value===''))return null;
  if(raw.some(value=>value===''||value===undefined))throw new Error('上游成本价必须完整填写输入、输出和缓存输入三项；免费请填 0。');
  return Object.fromEntries(keys.map((key,index)=>[key,Number(raw[index])]));
}
export function makeEditors(d:PlatformSnapshot,run:RunCommand,open:(editor:Editor)=>void,pickProvider?:(onPick:(providerId:string)=>void)=>void){
  const organizations=d.organizations.map(o=>option(o.id,organizationPath(d.organizations,o.id))),members=d.members.filter(m=>m.active).map(m=>option(m.id,memberLabel(d,m.id)));
  const yesNo=[option('yes','启用'),option('no','停用')];
  const defaultExpiry=toDateInput(new Date(Date.now()+30*86400000).toISOString());
  function validateService(v:FormValues){
    if(!values(v.definitionIds).length)throw new Error('请选择至少一个提供的模型；尚未登记时可在下方新建模型定义。');
    if(v.credentialMode==='managed'&&!(d.upstreamCredentials??[]).some(item=>item.id===v.credentialId&&item.providerId===v.providerId&&item.active))throw new Error('请选择当前供应商的有效托管凭据，或新建上游凭据后继续。');
    if(v.credentialMode==='environment'&&!/^UPSTREAM_[A-Z0-9_]+$/.test(String(v.credentialRef)))throw new Error('环境变量名称必须以 UPSTREAM_ 开头，只能包含大写字母、数字和下划线。供应商密钥请使用托管上游凭据。');
    if(v.credentialMode==='inline'&&!v.credentialSecret&&!scopedCredential(v))throw new Error('请填写供应商密钥，或改用已有托管凭据。');
  }
  /* A service-scoped secret is stored as a hidden credential; find it only to prefill the mode. */
  function scopedCredential(v:FormValues){return (d.upstreamCredentials??[]).some(item=>item.serviceId&&item.id===v.credentialId);}
  function rebuildWith(latest:PlatformSnapshot,recipe:(next:ReturnType<typeof makeEditors>)=>void):Editor{
    let result:Editor|undefined;recipe(makeEditors(latest,run,next=>{result=next;}));if(!result)throw new Error('无法恢复原表单');return result;
  }
  function relatedFields(fields:FieldSpec[],type:string,topup=false,initial:FormValues={}):FieldSpec[]{
    const related:Record<string,RelatedResource>={poolId:{kind:'pool',label:'新建模型池，完成后返回'},personalDefaultPoolId:{kind:'pool',label:'新建模型池，完成后返回'},projectDefaultPoolId:{kind:'pool',label:'新建模型池，完成后返回'},planId:{kind:'plan',label:'新建开通方案，完成后返回'},organizationId:{kind:'organization',label:'新建组织，完成后返回'},managerId:{kind:'member',label:'新建项目经理账号，完成后返回'},ownerId:{kind:'member',label:'新建负责人账号，完成后返回'},sponsorId:{kind:'member',label:'新建内部责任人，完成后返回'}};
    return fields.map(field=>{
      const scopes:Record<string,PersonScope>={managerId:'manager',ownerId:'owner',sponsorId:'sponsor',memberId:type==='project.allocate'?'project-allocation':'directory',memberIds:type==='project.members'?'project-members':'onboarding'};
      if(scopes[field.key])field={...field,type:'person',person:{scope:scopes[field.key],multiple:field.type==='multiple',projectId:typeof initial.projectId==='string'?initial.projectId:undefined,...field.person}};
      if(!d.actor.roles.includes('operator'))return field;
      const create=field.key.startsWith('service:')?{kind:'service' as const,label:'新建模型服务并验证，完成后返回',definitionId:field.key.slice(8)}:type==='save.service'&&field.key==='definitionIds'?{kind:'definition' as const,label:'新建模型定义，完成后返回'}:topup?undefined:related[field.key];
      return {...field,create:field.create??create};
    });
  }
  function edit(title:string,fields:FieldSpec[],initial:FormValues,type:string,transform:(values:FormValues)=>Record<string,unknown>,description?:string,onSaved?:(value:unknown)=>void,context?:Editor['context'],submitLabel?:string,danger=false){
    const fieldSpecs=relatedFields(fields,type,type==='distribution.execute'&&transform(initial).operation==='topup',initial);
    let saved:unknown;
    const editor:Editor={title,fields:fieldSpecs,initial,description,commandType:type,getResult:()=>saved,context,danger,submitLabel:submitLabel??(type==='save.service'?'保存模型服务':undefined),submit:async v=>{if(type==='save.service')validateService(v);if(type==='save.pool'&&fieldSpecs.some(f=>f.key==='serviceIds'&&f.required)&&!values(v.serviceIds).length)throw new Error('请选择至少一个未归属其他模型池的模型服务。');const result=await run(type,transform(v));if(result===null)return false;saved=result;onSaved?.(result);return true;}};
    const collections={'save.provider':'providers','save.definition':'definitions','save.service':'services','save.pool':'pools','save.plan':'plans','save.organization':'organizations','save.member':'members','save.project':'projects','save.application':'applications','save.rule':'rules'} as const;
    if(type in collections){
      const collection=collections[type as keyof typeof collections],id=type==='save.pool'?initial.id||undefined:transform(initial).id;
      editor.rebuild=latest=>rebuildWith(latest,next=>{
        if(id&&!latest[collection]?.some(value=>value.id===id))throw new Error('原对象已删除或不在当前权限范围，不能恢复编辑。');
        switch(type){
          case 'save.provider':next.provider(latest.providers?.find(v=>v.id===id));break;
          case 'save.definition':next.definition(latest.definitions.find(v=>v.id===id));break;
          case 'save.service':next.service(latest.services.find(v=>v.id===id),undefined,String(initial.providerId));break;
          case 'save.pool':next.pool(latest.pools.find(v=>v.id===id));break;
          case 'save.plan':next.plan(latest.plans.find(v=>v.id===id),value=>onSaved?.(value));break;
          case 'save.organization':next.organization(latest.organizations.find(v=>v.id===id));break;
          case 'save.member':next.member(latest.members.find(v=>v.id===id));break;
          case 'save.project':next.project(latest.projects.find(v=>v.id===id));break;
          case 'save.application':next.application(latest.applications.find(v=>v.id===id));break;
          case 'save.rule':next.rule(latest.rules.find(v=>v.id===id));break;
        }
      });
    }else if(type==='distribution.execute')editor.rebuild=latest=>rebuildWith(latest,next=>transform(initial).operation==='topup'?next.topup():next.grantPlan());
    else if(type==='approval.repair')editor.rebuild=latest=>rebuildWith(latest,next=>{const approval=latest.approvals.find(a=>a.id===transform(initial).id);if(!approval)throw new Error('当前申请已不在权限范围，不能继续修改。');next.repairApproval(approval);});
    else if(type==='settings.update'&&'personalDefaultPoolId' in initial)editor.rebuild=latest=>rebuildWith(latest,next=>next.defaults());
    open(editor);
  }
  function rangeFields():FieldSpec[]{return [
    {key:'poolId',label:'模型池',type:'select',required:true,options:d.pools.map(p=>option(p.id,p.name))},
    {key:'rangeMode',label:'模型范围',type:'select',required:true,options:[option('follow','跟随模型池'),option('specific','仅开放指定模型')]},
    {key:'definitionIds',label:'指定模型',type:'multiple',options:d.definitions.map(m=>option(m.id,memberLabel(d,m.id))),show:v=>v.rangeMode==='specific',help:'仅选择当前池内模型；后续新增模型不会自动扩大本范围。'},
  ];}
  const readRange=(v:FormValues)=>({poolId:String(v.poolId),mode:String(v.rangeMode),definitionIds:v.rangeMode==='specific'?values(v.definitionIds):[]});
  const rangeInitial=(r?:{poolId:string;mode:string;definitionIds:string[]},project=false):FormValues=>({poolId:r?.poolId??(project?d.settings.projectDefaultPoolId:d.settings.personalDefaultPoolId)??'',rangeMode:r?.mode??'follow',definitionIds:r?.definitionIds??[]});
  const moneyFields:FieldSpec[]=[{key:'amount',label:'金额（CNY）',type:'number',required:true},{key:'expiresAt',label:'有效日期（北京时间，当日结束）',type:'date',required:true}];
  const quotaFields:FieldSpec[]=[moneyFields[0],{key:'validity',label:'额度有效期',type:'choice',required:true,options:[option('dated','指定到期日'),option('permanent','长期有效')]},{...moneyFields[1],show:v=>v.validity!=='permanent'}];
  const readExpiry=(v:FormValues)=>v.validity==='permanent'?QUOTA_FOREVER:endOfDay(v.expiresAt);
  const initialQuotaFields=(show:(v:FormValues)=>boolean):FieldSpec[]=>quotaFields.map(f=>({...f,key:f.key==='amount'?'initialAmount':f.key,label:f.key==='amount'?'初始额度（CNY）':f.label,show:v=>show(v)&&(!f.show||f.show(v))}));
  const approvalFields=(a:PlatformSnapshot['approvals'][number]):FieldSpec[]=>{
    if(a.kind==='application_create'&&a.proposedApplication?.billingMode==='accounting')return [];
    if(a.kind==='project_member_quota')return [moneyFields[0]];
    const fields=a.kind.startsWith('personal_')?moneyFields:quotaFields;
    return fields.filter(f=>!a.kind.endsWith('_extend')||f.key!=='amount');
  };
  const conditionFields=(show?:(v:FormValues)=>boolean):FieldSpec[]=>[
    {key:'organizationId',label:'组织（留空不限）',type:'select',options:organizations,show},
    {key:'includeChildren',label:'组织层级',type:'select',options:[option('yes','包含下级组织'),option('no','仅选定组织本级')],show},
    {key:'category',label:'人员类别（留空不限）',type:'select',options:[option('employee','员工'),option('contractor','外部协作')],show},
    {key:'tags',label:'同时满足的业务标签',help:'英文逗号分隔。组织、人员类别与所有标签同时满足才命中。',show},
  ];
  const conditions=(v:FormValues)=>({organizationId:v.organizationId||null,includeChildren:v.includeChildren==='yes',category:v.category||null,tags:String(v.tags??'').split(',').map(t=>t.trim()).filter(Boolean)});
  function distribute(topup=false,planId?:string,memberId?:string){
    edit(topup?'追加已有方案额度':'开通个人方案',[
      {key:'planId',label:topup?'已有权益的来源方案':'个人开通方案',type:'select',required:true,options:d.plans.filter(p=>topup||p.active).map(p=>option(p.id,`${p.name} · ${p.amount} 元`))},
      {key:'scope',label:'人员范围',type:'select',required:true,options:[option('members','手动选择名单'),option('all','全体有效成员'),option('conditions','按组织 / 类别 / 标签筛选')]},
      {key:'memberIds',label:'本次人员名单',type:'multiple',required:true,options:d.members.map(m=>option(m.id,`${m.name}${m.active?'':'（停用）'}`)),show:v=>v.scope==='members'},
      ...conditionFields(v=>v.scope==='conditions'),...(topup?moneyFields:[]),
    ],{planId:planId??'',scope:'members',memberIds:memberId?[memberId]:[],organizationId:'',includeChildren:'yes',category:'',tags:'',amount:'',expiresAt:defaultExpiry},'distribution.execute',v=>({operation:topup?'topup':'open_plan',...(topup?{sourcePlanId:v.planId,amount:Number(v.amount),expiresAt:endOfDay(v.expiresAt)}:{planId:v.planId}),...(v.scope==='members'?{memberIds:values(v.memberIds)}:{scope:v.scope,...(v.scope==='conditions'?conditions(v):{})})}),topup?'仅向已有该方案有效权益的人员追加，不扩大模型范围。名单将显示跳过原因；追加到期日不能超出原权益。':'确认前冻结本次名单、逐人金额和到期日。停用、到期或已有有效方案权益的成员会被排除；不同方案分别开通。');
  }
  return {
    importMembers(){edit('导入成员',[{key:'source',label:'CSV / TSV 文件或粘贴表格',type:'import',required:true,help:'必填列：登录账号、姓名、组织。可选：人员类别、业务标签、状态、有效日期、责任人登录账号。组织可用唯一名称或 ID；标签以分号分隔；日期 YYYY-MM-DD。'}],{source:''},'import.members',v=>({rows:parseMemberImport(String(v.source),d)}),'按登录账号更新已有成员，未提供的列保留原值，空白可选单元格按字段清除。导入不更改职责或密码；新成员需在成员编辑中设置登录密码。先预览自动开通及总金额，确认后整批提交。');},
    rule(existing?:AutoRule){edit(existing?'编辑自动开通规则':'创建自动开通规则',[
      {key:'name',label:'规则名称',required:true},{key:'planId',label:'授予方案',type:'select',required:true,options:d.plans.map(p=>option(p.id,`${p.name}${p.active?'':'（停用）'}`))},...conditionFields(),{key:'active',label:'规则状态',type:'select',options:yesNo},
    ],{name:existing?.name??'',planId:existing?.planId??'',organizationId:existing?.organizationId??'',includeChildren:existing?.includeChildren===false?'no':'yes',category:existing?.category??'',tags:existing?.tags.join(', ')??'',active:existing?.active===false?'no':'yes'},'save.rule',v=>({id:existing?.id,name:v.name,planId:v.planId,...conditions(v),active:v.active==='yes'}),'保存后只在人员新增或属性变更时自动匹配。存量人员须另行“预览并应用”。同一人员命中同一方案的多个规则只发一次，不同方案叠加。停止匹配只停止未来周期发放，当前批次保留原期限。');},
    alertRule(existing?:AlertRule){
      const metrics=Object.entries(ALERT_METRICS).map(([key,value])=>option(key,`${value.label}（${value.unit}）`));
      edit(existing?'编辑告警规则':'创建告警规则',[
        {key:'name',label:'规则名称',required:true},{key:'poolId',label:'模型池范围（留空为全部）',type:'select',options:d.pools.map(pool=>option(pool.id,pool.name))},{key:'serviceId',label:'服务范围（留空为全部）',type:'select',options:d.services.map(s=>option(s.id,s.name))},{key:'modelId',label:'模型范围（留空为全部）',type:'select',options:d.definitions.map(m=>option(m.modelId,m.name))},
        {key:'metric',label:'指标与分母',type:'select',required:true,options:metrics},
        ...[['windowMinutes','统计窗口（分钟，1–60）'],['threshold','触发阈值（单位见指标），实际值 ≥ 阈值'],['minSamples','最小样本数（错误率和延迟适用）'],['triggerCount','连续触发次数'],['recoveryThreshold','恢复阈值（单位见指标），实际值 < 阈值'],['recoveryCount','连续恢复次数']].map(([key,label])=>({key,label,type:'number' as const,required:true})),
        {key:'active',label:'后续新事件',type:'select',options:[option('yes','启用'),option('no','暂停产生新事件')]},
      ],{name:existing?.name??'上游故障率',poolId:existing?.poolId??'',serviceId:existing?.serviceId??'',modelId:existing?.modelId??'',metric:existing?.metric??'upstream_failure_rate',windowMinutes:String(existing?.windowMinutes??5),threshold:String(existing?.threshold??10),minSamples:String(existing?.minSamples??20),triggerCount:String(existing?.triggerCount??2),recoveryThreshold:String(existing?.recoveryThreshold??5),recoveryCount:String(existing?.recoveryCount??2),active:existing?.active===false?'no':'yes'},'save.alert-rule',v=>({id:existing?.id,name:v.name,poolId:v.poolId||null,serviceId:v.serviceId||null,modelId:v.modelId||null,metric:v.metric,active:v.active==='yes',...Object.fromEntries(['windowMinutes','threshold','minSamples','triggerCount','recoveryThreshold','recoveryCount'].map(key=>[key,Number(v[key])]))}),'每分钟评估一个完整时间窗口。示例阈值尚未经过生产容量验证，请按实际调整。无流量、样本不足或采集失败不会解除告警。已有事件保留触发时规则直到恢复，修改配置仅影响后续新事件。');
    },
    upstreamCredential(existing?:PublicUpstreamCredential,providerId?:string){
      edit(existing?'轮换或停用上游凭据':'创建上游凭据',[
        {key:'name',label:'凭据名称',required:true},
        {key:'providerId',label:'所属供应商',type:'select',required:true,options:modelProviders(d.providers).filter(provider=>!existing||provider.id===existing.providerId).map(provider=>option(provider.id,provider.name))},
        {key:'secret',label:existing?'新凭据值（留空保留当前版本）':'供应商凭据值',type:'password',required:!existing,help:'加密保存。页面与日志不回显原值，完整值不会写入审计。'},
        {key:'active',label:'允许新调用',type:'select',options:yesNo},
      ],{name:existing?.name??'',providerId:existing?.providerId??providerId??'openai-compatible',secret:'',active:existing?.active===false?'no':'yes'},'credential.save',v=>({id:existing?.id,name:v.name,providerId:v.providerId,...(v.secret?{secret:v.secret}:{}),active:v.active==='yes'}),'轮换创建新版本并要求关联服务重新验证。已准入请求和视频任务继续使用原版本，禁用阻止新调用。',undefined,undefined,existing?'保存凭据变更':'保存上游凭据');
    },
    notificationChannel(existing?:WebhookChannel){
      edit('配置告警 Webhook',[{key:'name',label:'接收端名称',required:true},{key:'url',label:'HTTP(S) 接收地址',required:true,help:'使用独立签名验证身份，地址不含用户名、密码和查询参数。配置后向该接收端投递后续告警及恢复事件。'},{key:'signingKeyRef',label:'签名密钥环境变量引用',required:true,help:'控制面配置 NOTIFICATION_ 开头的环境变量，密钥至少 32 字节。接收方按时间戳和原始请求体验证 HMAC-SHA256。'},{key:'active',label:'接收新通知',type:'select',options:yesNo}],{name:existing?.name??'',url:existing?.url??'',signingKeyRef:existing?.signingKeyRef??'',active:existing?.active===false?'no':'yes'},'notification.channel.save',v=>({id:existing?.id,name:v.name,url:v.url,signingKeyRef:v.signingKeyRef,active:v.active==='yes'}));
    },
    alertSilence(rule:AlertRule){
      edit('调整告警静默',[{key:'mode',label:'通知策略',type:'select',required:true,options:[option('until','静默至指定时间'),option('clear','恢复通知')]},{key:'until',label:'静默结束时间',type:'datetime',required:true,show:v=>v.mode==='until',help:'最长七天。期间继续评估和记录事件，暂停本规则的新通知。'}],{mode:'until',until:new Date(Date.now()+3600000).toISOString()},'alert.silence',v=>({id:rule.id,until:v.mode==='clear'?null:new Date(String(v.until)).toISOString()}));
    },
    reconcile(log:CallLog){
      edit('核对调用费用',[{key:'mode',label:'核对结果',type:'select',required:true,options:[option('confirm_usage','根据已确认的完整用量结算'),option('release_hold','确认不计费，释放预占')]},
        {key:'inputTokens',label:'已确认输入 Token（含缓存子集）',type:'number',required:true,show:v=>v.mode==='confirm_usage'&&!log.admission?.price?.meter},
        {key:'outputTokens',label:'已确认输出 Token',type:'number',required:true,show:v=>v.mode==='confirm_usage'&&!log.admission?.price?.meter},
        {key:'cachedInputTokens',label:'其中缓存输入 Token',type:'number',required:true,show:v=>v.mode==='confirm_usage'&&!log.admission?.price?.meter},
        {key:'quantity',label:`已确认用量（${log.admission?.price?.meter?log.admission.price.meter.unit==='per_1000_characters'?'字符':METER_UNITS[log.admission.price.meter.unit]:''}）`,type:'number',step:'0.000001',required:true,show:v=>v.mode==='confirm_usage'&&!!log.admission?.price?.meter},
        {key:'reason',label:'依据与处理说明',type:'textarea',required:true}],{mode:'',quantity:log.meteredUsage?.quantity.toString()??'',inputTokens:log.usageFinal?String(log.inputTokens):'',outputTokens:log.usageFinal?String(log.outputTokens):'',cachedInputTokens:log.usageFinal?String(log.cachedInputTokens):'0',reason:''},'usage.reconcile',v=>({requestId:log.requestId,mode:v.mode,reason:v.reason,...(v.mode==='confirm_usage'?{inputTokens:Number(v.inputTokens),outputTokens:Number(v.outputTokens),cachedInputTokens:Number(v.cachedInputTokens),...(log.admission?.price?.meter?{meteredUsage:{unit:log.admission.price.meter.unit,quantity:Number(v.quantity)}}:{})}:{})}),`请求 ${log.requestId}。费用使用原预占时的价格；超出预占部分只能从同一原始批次补扣，余额不足时保持待核对。`);
    },
    organization(existing?:PlatformSnapshot['organizations'][number]){
      const root=!!existing&&!existing.parentId,excluded=existing?organizationTree(d.organizations,existing.id):new Set<string>();
      edit(existing?'编辑组织':'创建组织',[{key:'name',label:'组织名称',required:true},{key:'parentId',label:'上级组织',required:true,type:'select',options:organizations.filter(o=>!excluded.has(o.value)),show:()=>!root},{key:'active',label:'状态',type:'select',options:yesNo,show:()=>!root}],{name:existing?.name??'',parentId:existing?existing.parentId??'':'org-demo',active:existing?.active===false?'no':'yes'},'save.organization',v=>({id:existing?.id,name:v.name,parentId:root?null:v.parentId||null,active:root||v.active==='yes'}),root?'企业根组织只能修改名称，需保持启用且没有上级。':'移动或停用会影响本组织及所有下级成员。下一步列出访问变化、开通规则和发放金额；已发额度保留原期限。');
    },
    member(existing?:PlatformSnapshot['members'][number]){
      edit(existing?'编辑成员':'创建成员',[
        {key:'name',label:'姓名',required:true},{key:'directoryId',label:'登录账号',required:true,help:'同事用它登录平台，不能与他人重复。建议用姓名拼音或工号，例如 yanfa1。'},
        {key:'organizationId',label:'主要组织',type:'select',required:true,options:organizations},
        {key:'category',label:'人员类别',type:'select',options:[option('employee','员工'),option('contractor','外包 / 外部协作')]},
        {key:'tags',label:'业务标签',help:'多个标签使用英文逗号分隔，由运营维护。'},
        {key:'roles',label:'职责',type:'multiple',group:'账户与职责（按需调整）',options:Object.entries(ROLE_LABELS).map(([id,label])=>option(id,label))},
        {key:'sponsorId',label:'内部责任人',type:'select',person:{scope:'sponsor',excludeIds:existing?[existing.id]:[]},required:true,options:members,show:v=>v.category==='contractor'},
        {key:'validUntil',label:'人员有效日期',type:'date',requiredWhen:v=>v.category==='contractor',help:'外部人员必须填写；个人密钥不能超出人员有效期。'},
        {key:'active',label:'状态',type:'select',group:'账户与职责（按需调整）',options:yesNo},
        ...limitFields('member','人员使用限制'),
        {key:'password',label:existing?'设置新密码（留空保留）':'首次登录密码',type:'password',group:existing?'账户与职责（按需调整）':undefined,required:!existing,help:'至少 12 位。密码不会出现在成员列表和审计中。'},
      ],{name:existing?.name??'',directoryId:existing?.directoryId??'',organizationId:existing?.organizationId??d.actor.organizationId,category:existing?.category??'employee',tags:existing?.tags?.join(', ')??'',roles:existing?.roles??['employee'],sponsorId:existing?.sponsorId??'',validUntil:toDateInput(existing?.validUntil),active:existing?.active===false?'no':'yes',password:'',...limitInitial('member',existing?.limits)},'save.member',v=>({id:existing?.id,name:v.name,directoryId:v.directoryId,organizationId:v.organizationId,category:v.category,password:v.password,tags:String(v.tags).split(',').map(s=>s.trim()).filter(Boolean),roles:values(v.roles),active:v.active==='yes',validUntil:v.validUntil?endOfDay(v.validUntil):null,sponsorId:v.sponsorId||null,limits:readLimits('member',v)}));
    },
    definition(existing?:ModelDefinition){
      edit(existing?'编辑模型定义':'创建模型定义',[
        {key:'name',label:'显示名称',required:true},{key:'modelId',label:'对外模型标识',required:true},{key:'kind',label:'模型类型',type:'select',required:true,options:Object.entries(MODEL_KINDS).map(([id,name])=>option(id,name))},
        {key:'billingMultiplier',label:'计费倍率',type:'number',step:'0.000001',required:true,show:()=>hasPermission(d.actor,'pricing.write'),help:'0–100，最多六位小数。计费价 = 服务计费基准价 × 倍率；0 为业务免费，不免除上游成本。仅影响新请求。'},
        {key:'vendor',label:'厂商',help:'可选，面向用户展示；不从模型名称自动推断。'},
        {key:'contextTokens',label:'单次上下文 Token',type:'number',step:'1',required:true,help:'平台配置上限，参与调用准入。'},
        {key:'description',label:'能力说明',type:'textarea',help:'用一两句话介绍模型定位和适用任务，展示在用户模型卡片中。'},
        {key:'capabilities',label:'已确认接入能力',type:'multiple',options:Object.entries(MODEL_CAPABILITIES).map(([id,name])=>option(id,name)),help:'仅勾选已在当前平台接入中核实的能力。留空表示未维护，不表示不支持；修改资料不会自动验证模型。'},
        {key:'maxOutputTokens',label:'最大输出 Token（资料参考）',type:'number',step:'1',help:'可选，不超过配置上下文；只作选型参考，不设置调用保护上限。'},
        {key:'estimatedOutputTokens',label:'预占费用的预计输出 Token',type:'number',step:'1',help:'仅用于事前费用与 TPM 预估，不限制模型生成。留空使用默认 16384；可按该模型历史用量调整。'},
        {key:'active',label:'状态',type:'select',options:yesNo},
      ],{kind:existing?.kind??'chat',name:existing?.name??'',modelId:existing?.modelId??'',billingMultiplier:String(existing?.billingMultiplier??1),vendor:existing?.vendor??'',contextTokens:String(existing?.contextTokens??32768),capabilities:existing?.capabilities??[],maxOutputTokens:existing?.maxOutputTokens===undefined?'':String(existing.maxOutputTokens),estimatedOutputTokens:existing?.estimatedOutputTokens===undefined?'':String(existing.estimatedOutputTokens),description:existing?.description??'',active:existing?.active===false?'no':'yes'},'save.definition',v=>({id:existing?.id,...v,billingMultiplier:hasPermission(d.actor,'pricing.write')?Number(v.billingMultiplier):undefined,contextTokens:Number(v.contextTokens),maxOutputTokens:v.maxOutputTokens===''?null:Number(v.maxOutputTokens),estimatedOutputTokens:v.estimatedOutputTokens===''?null:Number(v.estimatedOutputTokens),active:v.active==='yes'}));
    },
    provider(existing?:ModelProvider){
      edit(existing?'编辑供应商':'创建供应商',[
        {key:'name',label:'供应商名称',required:true},{key:'description',label:'说明',type:'textarea'},
        {key:'baseUrl',label:'默认服务地址',help:'接入服务时预填；已有服务地址不会随模板变化。'},
        {key:'adapter',label:'接口适配器',type:'select',required:true,options:[option('openai','OpenAI 兼容'),option('cohere','Cohere'),option('xai','xAI'),option('volcengine','火山引擎')]},
        {key:'kinds',label:'支持的模型类型',type:'multiple',required:true,options:Object.entries(MODEL_KINDS).map(([id,name])=>option(id,name))},{key:'active',label:'供应商状态',type:'select',options:yesNo},
      ],{name:existing?.name??'',description:existing?.description??'',baseUrl:existing?.baseUrl??'',adapter:existing?.adapter??'openai',kinds:existing?.kinds??['chat'],active:existing?.active===false?'no':'yes'},'save.provider',v=>({id:existing?.id,name:v.name,description:v.description,baseUrl:v.baseUrl,adapter:v.adapter,kinds:values(v.kinds),active:v.active==='yes'}),'默认地址用于新接入。停用后停止关联服务的新请求；适配器或类型变化后，关联服务需要重新验证。接入时选择或创建托管上游凭据。');
    },
    providerDelete(existing:ModelProvider){
      const services=d.services.filter(service=>(service.providerId??'openai-compatible')===existing.id),credentials=(d.upstreamCredentials??[]).filter(item=>item.providerId===existing.id),restore=BUILTIN_PROVIDERS.some(item=>item.id===existing.id);
      const blockers=[services.length?`${services.length} 个模型服务`:'',credentials.length?`${credentials.length} 个上游凭据`:''].filter(Boolean).join('、');
      edit(`${restore?'恢复默认供应商':'删除供应商'} · ${existing.name}`,[{key:'confirm',label:`输入供应商名称“${existing.name}”以确认`,required:true}],{confirm:''},'delete.provider',v=>{if(String(v.confirm).trim()!==existing.name)throw new Error('名称不一致，未执行。');return {id:existing.id};},restore?'删除本地改写，回到内置默认地址与类型；历史调用、审计与已发布路由按原版本保留。':`删除后该供应商不再可选；历史调用与审计保留。${blockers?`当前仍有关联：${blockers}，需先迁移或停用。`:'当前无关联服务与凭据。'}`,
        undefined,undefined,restore?'恢复默认':'删除供应商',true);
    },
    service(existing?:ModelService,definitionId?:string,providerId?:string,pricesOnly=false):Editor|void{
      /* New service starts from the provider picker: the template decides adapter and address. */
      if(!existing&&!providerId&&!pricesOnly&&pickProvider){pickProvider(id=>{const picked=makeEditors(d,run,open,pickProvider).service(undefined,definitionId,id);if(picked)open(picked);});return;}
      const providers=modelProviders(d.providers),provider=providers.find(p=>p.id===(existing?.providerId??providerId??'openai-compatible'));
      const credentials=d.upstreamCredentials??[],scoped=credentials.find(item=>item.serviceId&&item.id===existing?.credentialId);
      const fields:FieldSpec[]=[{key:'name',label:'服务名称',required:true},{key:'providerId',label:'供应商',type:'select',required:true,options:providers.map(p=>option(p.id,p.name+(p.active?'':'（停用）'))),onChange:(value,v)=>({credentialId:credentials.some(item=>item.id===v.credentialId&&item.providerId===value)?v.credentialId:'',baseUrl:!v.baseUrl||v.baseUrl===providers.find(p=>p.id===v.providerId)?.baseUrl?providers.find(p=>p.id===value)?.baseUrl??'':v.baseUrl})},{key:'baseUrl',label:'服务地址',required:true,help:'HTTP(S) 地址，不包含用户名、密码、查询参数。'},
        {key:'credentialMode',label:'身份验证方式',type:'select',required:true,options:[option('managed','选择已有托管凭据'),option('managed','新建托管凭据，可被其他服务选用')].length?[option('managed','选择已有托管凭据'),option('inline','自定义密钥（仅用于当前模型服务）'),option('environment','服务端环境变量（高级）'),option('none','无需凭据')]:[],help:'密钥由控制面加密保存，页面不会回显明文。新建可复用的凭据请在下方“新建上游凭据”。'},
        {key:'credentialId',label:'托管上游凭据',type:'select',required:true,show:v=>v.credentialMode==='managed',optionsWhen:v=>credentials.filter(item=>!item.serviceId&&item.providerId===v.providerId&&(item.active||item.id===existing?.credentialId)).map(item=>option(item.id,`${item.name} · v${item.currentVersion}${item.active?'':' · 已停用'}`)),help:'仅显示当前供应商下可复用的凭据。没有可选项时，可在下方新建并自动回填。',create:hasPermission(d.actor,'credentials.write')?{kind:'upstreamCredential',label:'新建上游凭据，完成后返回'}:undefined},
        {key:'credentialSecret',label:'供应商密钥',type:'password',show:v=>v.credentialMode==='inline',required:!scoped,group:'服务内密钥',help:scoped?`当前已保存 v${scoped.currentVersion}；留空保留原值，填写则轮换新版本。该密钥只属于本服务，不出现在上游凭据列表。`:'仅加密保存到当前模型服务，不创建可复用凭据；服务删除后不再需要。'},
        {key:'credentialRef',label:'服务端环境变量名称',show:v=>v.credentialMode==='environment',required:true,group:'服务端凭据配置（高级）',help:'仅填写运维已配置的 UPSTREAM_ 环境变量名称，例如 UPSTREAM_VENDOR_API_KEY；供应商密钥请改用托管凭据。'},
        {key:'active',label:'服务状态',type:'select',options:yesNo},{key:'responsesPath',label:'Responses 路径',group:'接口路径（可选）'},{key:'messagesPath',label:'Messages 路径',group:'接口路径（可选）'},...limitFields('service','服务整体保护'),{key:'sharedCapacityId',label:'共享容量标识（可选）',group:'使用保护（按需调整）',help:'同一标识共用容量保护。'},{key:'definitionIds',label:'提供的模型',type:'multiple',required:true,options:d.definitions.map(m=>option(m.id,`${m.name} · ${MODEL_KINDS[m.kind??'chat']}`))}];
      fields.push({key:'cancelPath',label:'供应商视频取消路径（按需配置）',help:'仅在供应商明确支持取消时配置，必须包含 {id}，例如 /v1/videos/{id}/cancel。不会为未配置服务提供取消操作。',group:'视频任务取消（按需配置）'},{key:'cancelMethod',label:'供应商取消方法',type:'select',options:[option('POST','POST'),option('DELETE','DELETE')],group:'视频任务取消（按需配置）',show:v=>!!v.cancelPath});
      const initial:FormValues={credentialMode:scoped?'inline':existing?.credentialId?'managed':existing?.credentialRef?'environment':existing?'none':'inline',credentialSecret:'',cancelPath:existing?.videoCancellation?.path??'',cancelMethod:existing?.videoCancellation?.method??'POST',providerId:provider?.id??'openai-compatible',responsesPath:existing?.protocolPaths?.responses??'',messagesPath:existing?.protocolPaths?.messages??'',name:existing?.name??'',baseUrl:existing?.baseUrl??provider?.baseUrl??'',credentialId:existing?.credentialId??'',credentialRef:existing?.credentialRef??'',active:existing?.active===false?'no':'yes',definitionIds:existing?.mappings.map(m=>m.definitionId)??(definitionId?[definitionId]:[]),sharedCapacityId:existing?.sharedCapacityId??'',...limitInitial('service',existing?.limits)};
      for(const [kind,label] of Object.entries(MODEL_KINDS)){if(kind==='chat')continue;fields.push({key:`path:${kind}`,label:`${label}路径`,group:'接口路径（可选）',help:'同一服务的绝对路径；视频查询在提交路径后追加任务 ID。'});initial[`path:${kind}`]=existing?.modalityPaths?.[kind as keyof typeof MODEL_KINDS]??'';}
      for(const definition of d.definitions){
        const id=definition.id,mapping=existing?.mappings.find(m=>m.definitionId===id),kind=definition.kind??'chat',show=(v:FormValues)=>values(v.definitionIds).includes(id),token=(v:FormValues)=>show(v)&&v[`unit:${id}`]==='tokens',meter=(v:FormValues)=>show(v)&&!token(v);
        const defaultUnit=kind==='image'?'per_image':kind==='tts'?'per_1000_characters':kind==='asr'||kind==='video'?'per_second':'tokens';
        fields.push({key:`upstream:${id}`,label:`${definition.name} · 上游标识`,required:true,show},{key:`unit:${id}`,label:`${definition.name} · 计价单位`,type:'select',required:true,show,options:[...(['chat','embeddings','rerank'].includes(kind)?[option('tokens','每百万 Token')]:[]),...Object.entries(METER_UNITS).filter(([unit])=>kind!=='chat'&&(unit==='per_request'||unit===defaultUnit)).map(([unit,name])=>option(unit,name))]});
        initial[`unit:${id}`]=mapping?.meter?.unit??defaultUnit;
        for(const [field,label] of [['input','输入'],['output','输出'],['cachedInput','缓存输入']]){fields.push({key:`${field}:${id}`,label:`${definition.name} · ${label}基准价（元 / 百万 Token）`,type:'number',step:'0.000001',show:token,help:'免费填 0；未知留空。'});initial[`${field}:${id}`]=mapping?.[`${field}Price` as 'inputPrice']?.toString()??'';}
        fields.push(...(['inputPrice','outputPrice','cachedInputPrice'] as const).map((field,index)=>({key:`cost:${field}:${id}`,label:`${definition.name} · ${['输入','输出','缓存输入'][index]}成本价（元 / 百万 Token）`,type:'number' as const,required:true,show:token,group:`${definition.name} · 上游成本`,help:'必填，按供应商实际成本填写；免费填 0。'})));
        for(const field of ['inputPrice','outputPrice','cachedInputPrice'] as const)initial[`cost:${field}:${id}`]=mapping?.costPrice?.[field]?.toString()??'';
        for(const [field,label,help] of [['price','单位计费基准价（CNY）','免费填 0；未知留空。'],['costPrice','单位上游成本（CNY）','必填，与收费独立；免费填 0。'],['estimatedUnits','默认预占用量','上游未提供预估时使用。'],['maxUnits','单次最大用量','拒绝超出上限的请求。']]){fields.push({key:`meter:${field}:${id}`,label:`${definition.name} · ${label}`,type:'number',step:'0.000001',show:meter,required:field==='costPrice'||field==='estimatedUnits'||field==='maxUnits',help});initial[`meter:${field}:${id}`]=mapping?.meter?.[field as 'price']?.toString()??(field==='estimatedUnits'?'1':field==='maxUnits'?'1000':'');}
        initial[`upstream:${id}`]=mapping?.upstreamModel??definition.modelId;fields.push(...limitFields(`mapping:${id}`,`${definition.name} · 模型入口保护`,show));Object.assign(initial,limitInitial(`mapping:${id}`,mapping?.limits));
      }
      const priceField=(field:FieldSpec)=>/^(unit:|input:|output:|cachedInput:|cost:|meter:)/.test(field.key);
      const visibleFields=pricesOnly?fields.filter(priceField):hasPermission(d.actor,'pricing.write')?fields:fields.filter(field=>!priceField(field));
      edit(pricesOnly?'调整模型计价':existing?'编辑模型服务':'接入模型服务',visibleFields,initial,pricesOnly?'pricing.update':'save.service',v=>{
        const payload={id:existing?.id,videoCancellation:v.cancelPath?{path:v.cancelPath,method:v.cancelMethod}:null,name:v.name,providerId:v.providerId,baseUrl:v.baseUrl,protocolPaths:{...(v.responsesPath?{responses:v.responsesPath}:{}),...(v.messagesPath?{messages:v.messagesPath}:{})},modalityPaths:Object.fromEntries(Object.keys(MODEL_KINDS).filter(k=>v[`path:${k}`]).map(k=>[k,v[`path:${k}`]])),credentialId:v.credentialMode==='inline'?existing?.credentialId??null:v.credentialMode==='managed'?v.credentialId||null:null,credentialRef:v.credentialMode==='environment'?v.credentialRef||null:null,credentialSecret:v.credentialMode==='inline'&&v.credentialSecret?String(v.credentialSecret):undefined,active:v.active==='yes',limits:readLimits('service',v),sharedCapacityId:v.sharedCapacityId||null,mappings:values(pricesOnly?initial.definitionIds:v.definitionIds).map(id=>{const metered=v[`unit:${id}`]!=='tokens';return {definitionId:id,upstreamModel:v[`upstream:${id}`],meter:metered&&v[`meter:price:${id}`]!==''?{unit:v[`unit:${id}`],price:Number(v[`meter:price:${id}`]),costPrice:v[`meter:costPrice:${id}`]===''?null:Number(v[`meter:costPrice:${id}`]),estimatedUnits:Number(v[`meter:estimatedUnits:${id}`]),maxUnits:Number(v[`meter:maxUnits:${id}`])}:null,costPrice:metered?null:readCostPrice(v,id),...(Object.fromEntries(['input','output','cachedInput'].map(k=>[k+'Price',metered?null:v[`${k}:${id}`]===''?null:Number(v[`${k}:${id}`])])) as Record<'inputPrice'|'outputPrice'|'cachedInputPrice',number|null>),limits:readLimits(`mapping:${id}`,v)};})};
        if(pricesOnly)return {serviceId:existing!.id,mappings:payload.mappings.map(({definitionId,inputPrice,outputPrice,cachedInputPrice,costPrice,meter})=>({definitionId,inputPrice,outputPrice,cachedInputPrice,costPrice,meter}))};
        if(!hasPermission(d.actor,'pricing.write'))payload.mappings=payload.mappings.map(mapping=>{const technical={...mapping} as Record<string,unknown>;for(const key of ['inputPrice','outputPrice','cachedInputPrice','costPrice','meter'])delete technical[key];return technical as typeof mapping;});
        return payload;
      },'聊天模型探测 Chat / Responses / Messages；其他类型验证模型目录连通性，生成效果需实际调用验证。保存配置不会自动产生付费生成请求。历史调用按原快照结算。');
    },
    pricing(existing:ModelService){this.service(existing,undefined,undefined,true);},
    multiplier(existing:ModelDefinition){
      edit('调整模型计费倍率',[{key:'billingMultiplier',label:'计费倍率',type:'number',step:'0.000001',required:true,help:'0–100，最多六位小数。仅影响新准入调用。'}],{billingMultiplier:String(existing.billingMultiplier??1)},'pricing.update',v=>({definitionId:existing.id,billingMultiplier:Number(v.billingMultiplier)}));
    },
    pool(existing?:ModelPool){
      const occupied=new Set(d.pools.filter(p=>p.id!==existing?.id).flatMap(p=>p.entries.map(e=>e.serviceId)));
      const services=d.services.filter(s=>!occupied.has(s.id)||existing?.entries.some(e=>e.serviceId===s.id));
      const fields:FieldSpec[]=[{key:'name',label:'模型池名称',required:true},{key:'strategy',label:'路由策略',type:'select',required:true,options:Object.entries(ROUTING_STRATEGIES).map(([id,name])=>option(id,name))},{key:'failureThreshold',label:'连续故障隔离阈值（0 关闭）',type:'number',required:true,help:'已转发的上游错误、超时或部分失败；业务拒绝不计入。'},{key:'cooldownSeconds',label:'隔离时间（秒）',type:'number',required:true},
        {key:'serviceIds',label:'纳入的模型服务',type:'multiple',required:!existing,options:services.map(s=>option(s.id,`${s.name} · ${s.mappings.map(m=>d.definitions.find(def=>def.id===m.definitionId)?.name??m.definitionId).join('、')}${!s.active?' · 已停用':s.verification!=='passed'?' · 未通过验证':''}`)),help:services.length?'仅可选择未归属其他模型池的服务；同一模型可由多个服务共同承接请求。加入服务会纳入其当前提供的全部模型，默认暂不开放。':'没有未归属的模型服务。请先新建服务，或从原模型池移除所需服务。',create:{kind:'service',label:'新建模型服务并验证，完成后返回'}},
        ...limitFields('pool','模型池总保护')];
      const initial:FormValues={strategy:existing?.routing?.strategy??'stable',failureThreshold:String(existing?.routing?.failureThreshold??0),cooldownSeconds:String(existing?.routing?.cooldownSeconds??30),id:existing?.id??'',name:existing?.name??'',serviceIds:[...new Set(existing?.entries.map(e=>e.serviceId)??[])],...limitInitial('pool',existing?.limits)};
      for(const service of services)for(const mapping of service.mappings){
        const key=`open:${service.id}:${mapping.definitionId}`,entry=existing?.entries.find(e=>e.serviceId===service.id&&e.definitionId===mapping.definitionId);
        fields.push({key,label:`${service.name} · ${d.definitions.find(def=>def.id===mapping.definitionId)?.name??mapping.definitionId}`,type:'select',options:[option('no','已加入，暂不开放'),option('yes','开放使用')],show:v=>values(v.serviceIds).includes(service.id),group:'模型开放状态（按需调整）'});
        initial[key]=entry?.open?'yes':'no';
        for(const [field,label,fallback] of [['weight','分流权重',1],['priority','优先级（数值越小越优先）',0]] as const){fields.push({key:`${field}:${service.id}:${mapping.definitionId}`,label:`${service.name} · ${label}`,type:'number',required:true,show:v=>values(v.serviceIds).includes(service.id),group:'路由权重与优先级'});initial[`${field}:${service.id}:${mapping.definitionId}`]=String(entry?.[field]??fallback);}
      }
      edit(existing?'调整模型池':'创建模型池',fields,initial,'save.pool',v=>{
        const selected=values(v.serviceIds).map(id=>{const service=services.find(s=>s.id===id);if(!service)throw new Error('所选模型服务已不可用，请重新打开表单。');return service;});
        const entries=selected.flatMap(service=>service.mappings.map(mapping=>{
          return {definitionId:mapping.definitionId,serviceId:service.id,weight:Number(v[`weight:${service.id}:${mapping.definitionId}`]),priority:Number(v[`priority:${service.id}:${mapping.definitionId}`]),open:v[`open:${service.id}:${mapping.definitionId}`]==='yes'};
        }));
        return {id:existing?.id,name:v.name,routing:{strategy:v.strategy,failureThreshold:Number(v.failureThreshold),cooldownSeconds:Number(v.cooldownSeconds)},limits:readLimits('pool',v),entries};
      },'按模型服务组织模型池，每个服务只能归属一个模型池。同一模型的多个已开放服务共同分流；服务容量仍受池、用户与共享容量保护约束。跟随模式的权益会同步开放范围；指定模式不自动扩大。变更不会转移任何资金。');
    },
    plan(existing?:Plan,onSaved?:(plan:Plan)=>void){
      edit(existing?'编辑个人方案模板':'创建个人开通方案',[{key:'name',label:'方案名称',required:true},...rangeFields(),{key:'amount',label:'每次发放金额（CNY）',type:'number',required:true},{key:'cadence',label:'发放周期',type:'select',options:[option('once','一次性'),option('monthly','每月，不结转')]},{key:'quotaDays',label:'一次性额度有效天数',type:'number',required:true,show:v=>v.cadence==='once'},{key:'entitlementDays',label:'模型权益有效天数',type:'number',required:true},...limitFields('plan','方案默认保护'),{key:'active',label:'方案状态',type:'select',options:yesNo}],{name:existing?.name??'',...rangeInitial(existing?.range),...limitInitial('plan',existing?.limits),active:existing?.active===false?'no':'yes',amount:String(existing?.amount??100),cadence:existing?.cadence??'monthly',quotaDays:String(existing?.quotaDays??30),entitlementDays:String(existing?.entitlementDays??365)},'save.plan',v=>({id:existing?.id,name:v.name,range:readRange(v),amount:Number(v.amount),cadence:v.cadence,active:v.active==='yes',quotaDays:Number(v.quotaDays),entitlementDays:Number(v.entitlementDays),limits:readLimits('plan',v)}),'方案可在后续开通时复用，保存方案本身不发放额度。修改模板产生新版本，已授予权益保留授予时版本。',value=>onSaved?.(value as Plan),undefined,'保存开通方案');
    },
    grantPlan(planId?:string,memberId?:string){
      distribute(false,planId,memberId);
    },
    migrateEntitlements(entitlement?:Entitlement){
      edit('迁移存量权益到当前方案版本',[
        {key:'planId',label:'目标方案（仅限同一方案内版本迁移）',type:'select',required:true,options:d.plans.filter(p=>p.active).map(p=>option(p.id,`${p.name} · 当前 v${p.version}`))},
        {key:'entitlementIds',label:'要迁移的有效权益',type:'multiple',required:true,options:d.entitlements.map(e=>option(e.id,`${d.members.find(m=>m.id===e.memberId)?.name??e.memberId} · ${e.planSnapshot.name} v${e.planVersion} · ${e.planSnapshot.cadence==='monthly'?'月度':'一次性'}`)),help:'只能选择同一方案、同一发放周期的权益。跨方案、一次性/月度互转、已到期或已吊销的权益会在预览中列为不适用，必须重新预览。'},
        {key:'reason',label:'迁移依据',type:'textarea',required:true},
      ],{planId:entitlement?.planId??'',entitlementIds:entitlement?[entitlement.id]:[],reason:''},'entitlements.migrate',v=>({planId:v.planId,entitlementIds:values(v.entitlementIds),reason:v.reason}),'只更新权益的版本、快照与模型范围，保留权益 ID、授予时间、到期日、来源、规则关联与已发周期；不补差、不发新额度、不重复发本月额度。已有资金的模型适用范围可能扩大或收缩，请在预览中逐人确认。');
    },
    topup(planId?:string,memberId?:string){distribute(true,planId,memberId);},
    project(existing?:Project){
      edit(existing?'编辑项目':'创建项目',[{key:'name',label:'项目名称',required:true},{key:'description',label:'业务说明',type:'textarea'},{key:'managerId',label:'项目经理',type:'select',required:true,options:members},...initialQuotaFields(()=>!existing),...rangeFields(),...limitFields('project','项目整体保护'),{key:'status',label:'项目状态',type:'select',options:[option('active','启用'),option('paused','暂停')]}],{initialAmount:'',validity:'dated',expiresAt:'',name:existing?.name??'',description:existing?.description??'',managerId:existing?.managerId??'',...rangeInitial(existing?.range,true),...limitInitial('project',existing?.limits),status:existing?.status??'active'},'save.project',v=>({id:existing?.id,...(!existing?{initialAmount:Number(v.initialAmount),expiresAt:readExpiry(v)}:{}),name:v.name,description:v.description,managerId:v.managerId,range:readRange(v),status:v.status,limits:readLimits('project',v)}),'创建时同时发放初始项目预算；添加成员后再分配，成员不会自动获得余额。编辑不改变已有额度。');
    },
    projectMembers(project:Project){edit('添加项目成员',[{key:'memberIds',label:'有效企业成员',type:'multiple',required:true,options:members.filter(m=>!project.memberIds.includes(m.value))}],{memberIds:[],projectId:project.id},'project.members',v=>({projectId:project.id,memberIds:values(v.memberIds)}),'加入项目只建立成员关系，不自动发放额度。');},
    endProject(project:Project){edit('结束项目并回收未使用余额',[{key:'reason',label:'结束依据',type:'textarea',required:true}],{reason:''},'project.end',v=>({projectId:project.id,reason:v.reason}),'结束为终态。未分配预算与成员未使用余额进入结束回收记录，不转入个人或其他项目。已准入请求按原来源继续结算，后续释放预占也进入回收金额。');},
    fund(kind:'project'|'application',object:Project|Application){edit(`向${kind==='project'?'项目':'应用'}发放额度`,[...quotaFields,{key:'reason',label:'发放原因',type:'textarea',required:true}],{amount:'',validity:kind==='application'?'permanent':'dated',expiresAt:'',reason:''},`${kind}.fund`,v=>({[kind==='project'?'projectId':'applicationId']:object.id,amount:Number(v.amount),expiresAt:readExpiry(v),reason:v.reason}),`${object.name} · 每次发放形成独立批次，保留原有期限。`);},
    allocate(project:Project,memberId?:string){
      const budgets=d.projectBudgets.filter(b=>b.projectId===project.id&&!b.closedAt&&b.availableAmount>0&&Date.parse(b.expiresAt)>Date.now()).sort((a,b)=>Date.parse(a.expiresAt)-Date.parse(b.expiresAt)||a.id.localeCompare(b.id));
      edit('分配项目成员额度',[{key:'sourceBatchId',label:'项目来源批次',type:'select',required:true,options:budgets.map(b=>option(b.id,`${b.availableAmount} 元待分配 · ${date(b.expiresAt)}`))},{key:'memberId',label:'项目成员',type:'select',required:true,options:members.filter(m=>project.memberIds.includes(m.value))},{key:'amount',label:'分配金额（CNY）',type:'number',required:true}],{sourceBatchId:budgets[0]?.id??'',memberId:memberId??'',amount:'',projectId:project.id},'project.allocate',v=>({projectId:project.id,sourceBatchId:v.sourceBatchId,memberId:v.memberId,amount:Number(v.amount)}),'从选定的项目批次转为成员可用额度，继承到期日，不会再次为项目充值。');
    },
    application(existing?:Application){edit(existing?'编辑应用':'创建独立应用',[{key:'completionChannelId',label:'视频任务完成回调',type:'select',options:(d.notificationChannels??[]).map(channel=>option(channel.id,channel.name)),show:()=>hasPermission(d.actor,'administration.manage'),help:'在运行监控中配置具备签名密钥的 Webhook。该应用的新视频任务完成后投递结果通知。'},{key:'billingMode',label:'计费模式',type:'choice',required:true,options:[option('accounting','记账模式 · 0 元起用，余额可为负'),option('quota','额度模式 · 额度用完即停')],show:()=>!existing,help:'创建后不能直接修改模式。记账转额度需由负责人申请，审批后生效。'},{key:'name',label:'应用名称',required:true},{key:'ownerId',label:'应用负责人',type:'select',required:true,options:members},{key:'handoffKeys',label:'负责人变更时的现有密钥',type:'choice',required:true,options:[option('revoke','吊销旧密钥，重新签发'),option('preserve','保留旧密钥继续使用')],show:v=>!!existing&&v.ownerId!==existing.ownerId,help:'旧负责人可能保存过完整密钥；仅交接管理权限不会撤回已复制的密钥。'},{key:'organizationId',label:'归属组织',type:'select',required:true,options:organizations},...initialQuotaFields(v=>!existing&&v.billingMode==='quota'),{key:'description',label:'接入用途',type:'textarea'},...rangeFields(),...limitFields('application','应用整体保护'),{key:'active',label:'状态',type:'select',options:yesNo}],{completionChannelId:existing?.completionChannelId??'',handoffKeys:'revoke',initialAmount:'',validity:'permanent',expiresAt:'',billingMode:existing?applicationBillingMode(existing):'accounting',name:existing?.name??'',ownerId:existing?.ownerId??'',organizationId:existing?.organizationId??'org-demo',description:existing?.description??'',...rangeInitial(existing?.range),...limitInitial('application',existing?.limits),active:existing?.active===false?'no':'yes'},'save.application',v=>({id:existing?.id,...(!existing&&v.billingMode==='quota'?{initialAmount:Number(v.initialAmount),expiresAt:readExpiry(v)}:{}),completionChannelId:hasPermission(d.actor,'administration.manage')?v.completionChannelId||null:undefined,billingMode:existing?applicationBillingMode(existing):v.billingMode,name:v.name,ownerId:v.ownerId,organizationId:v.organizationId,handoffKeys:v.handoffKeys,description:v.description,range:readRange(v),active:v.active==='yes',limits:readLimits('application',v)}),existing?`当前为${applicationBillingMode(existing)==='accounting'?'记账':'额度'}模式。记账转额度需从应用详情发起申请，审批后生效。`:'记账模式从 0 元开始记账；额度模式创建时同时发放填写的初始额度。不借用负责人的个人或项目余额。');},
    key(initialPurpose:'personal'|'project'|'application'='personal',objectId?:string){
      const bound=!!objectId&&initialPurpose!=='personal',name=initialPurpose==='application'?d.applications.find(a=>a.id===objectId)?.name:d.projects.find(p=>p.id===objectId)?.name;
      const fields:FieldSpec[]=[{key:'name',label:'密钥名称',required:true}];
      if(!bound)fields.push({key:'purpose',label:'扣费用途',type:'select',required:true,onChange:()=>({entitlementMode:'all',entitlementIds:[]}),options:[option('personal','个人 · 日常办公'),option('project','项目成员'),...(d.applications.length?[option('application','独立应用')]:[])]},{key:'projectId',label:'项目',type:'select',options:d.projects.filter(p=>p.memberIds.includes(d.actor.id)&&p.status==='active').map(p=>option(p.id,p.name)),show:v=>v.purpose==='project'},{key:'applicationId',label:'应用',type:'select',options:d.applications.filter(a=>a.active).map(a=>option(a.id,a.name)),show:v=>v.purpose==='application'});
      const entitlements=d.entitlements.filter(e=>e.memberId===d.actor.id&&e.status==='active'&&Date.parse(e.expiresAt)>Date.now());
      fields.push({key:'entitlementMode',label:'套餐范围',type:'choice',required:true,show:v=>v.purpose==='personal',options:[option('all','全部有效套餐'),option('specific','指定套餐')],help:'全部有效套餐会跟随后续新开通的套餐；指定套餐只使用所选套餐的模型池和额度，不借用范围外余额。'},
        {key:'entitlementIds',label:'允许使用的套餐',type:'multiple',required:true,show:v=>v.purpose==='personal'&&v.entitlementMode==='specific',options:entitlements.map(e=>{const balance=d.quotaBatches.filter(b=>b.entitlementId===e.id&&!b.closedAt&&Date.parse(b.expiresAt)>Date.now()).reduce((sum,b)=>sum+b.availableAmount,0),models=availablePlanModels(d,{...e.planSnapshot,range:e.range});return option(e.id,`${e.planSnapshot.name} · ${d.pools.find(p=>p.id===e.range.poolId)?.name??'模型池已不存在'} · ${models.join('、')||'暂无可用模型'} · 余额 ${Number(balance.toFixed(6))} 元 · ${toDateInput(e.expiresAt)} 到期`);}),help:entitlements.length?'至少选择一个已开通套餐，可多选。所选套餐到期或停用后，不会自动切换到其他套餐。':'当前账号暂无有效个人套餐，请先由运营为当前账号开通。'});
      fields.push({key:'expiresAt',label:'到期日期',type:'date',required:true});
      edit(bound?`为${name??'当前用途'}签发密钥`:'签发用途密钥',fields,{name:bound?`${name??'当前用途'}接入`:'',purpose:initialPurpose,entitlementMode:'all',entitlementIds:[],projectId:initialPurpose==='project'?objectId??'':'',applicationId:initialPurpose==='application'?objectId??'':'',expiresAt:toDateInput(new Date(Date.now()+90*86400000).toISOString())},'key.issue',v=>{
        const purpose=bound?initialPurpose:v.purpose,entitlementIds=purpose==='personal'&&v.entitlementMode==='specific'?values(v.entitlementIds):undefined;
        if(entitlementIds&&!entitlementIds.length)throw new Error('请至少选择一个允许使用的套餐。');
        return {name:v.name,purpose,entitlementIds,projectId:bound?initialPurpose==='project'?objectId:null:v.projectId||null,applicationId:bound?initialPurpose==='application'?objectId:null:v.applicationId||null,expiresAt:endOfDay(v.expiresAt)};
      },`${bound?`已绑定 ${name??'当前用途'}。`:''}完整值只在签发成功时显示一次。密钥名称仅作标识，同一套餐下的多把密钥共享额度与限制。`);
    },
    quotaChange(kind:'project'|'application',object:Project|Application,batchId:string,operation:'extend'|'reclaim'|'return'){
      const extension=operation==='extend',batch=kind==='project'&&operation!=='return'?d.projectBudgets.find(b=>b.id===batchId):d.quotaBatches.find(b=>b.id===batchId);
      if(extension&&!hasPermission(d.actor,'finance.write')){this.request(`${kind}_extend`,object.id,undefined,undefined,batchId);return;}
      edit(extension?'延长额度有效期':operation==='return'?'退回成员额度':'回收未使用额度',[...(extension?quotaFields.filter(f=>f.key!=='amount'):[moneyFields[0]]),{key:'reason',label:'变更原因',type:'textarea',required:true}],{amount:'',validity:'dated',expiresAt:batch&&!isPermanentQuota(batch.expiresAt)?toDateInput(batch.expiresAt):'',reason:''},`${kind}.${operation}`,v=>({[kind==='project'?'projectId':'applicationId']:object.id,batchId,amount:extension?undefined:Number(v.amount),expiresAt:extension?readExpiry(v):undefined,reason:v.reason}),extension?'仅延长未过期额度；项目成员关联批次同步延期，不增加金额。':operation==='return'?'仅退回当前未使用或已关闭的余额至原预算；在途请求后续释放金额仍保留在原批次，可再次退回。原预算已过期或关闭时进入回收记录。':'仅回收未使用、未预占的余额；保留原授额与消费，不抵扣其他批次。',undefined,undefined,'预览额度变更',!extension);
    },
    request(kind:string,objectId?:string,previous?:PlatformSnapshot['approvals'][number],onSubmitted?:(id:string)=>void,batchId?:string){
      const appCreate=kind==='application_create',extension=kind.endsWith('_extend');
      const fields:FieldSpec[]=[{key:'name',label:appCreate?'应用名称':'项目名称',required:true,show:()=>appCreate||kind==='project_create'},{key:'managerId',label:'建议项目经理',type:'select',options:members,show:()=>kind==='project_create'},
        {key:'billingMode',label:'计费模式',type:'choice',required:true,options:[option('accounting','记账模式'),option('quota','额度模式')],show:()=>appCreate},
        {key:'ownerId',label:'建议应用负责人',type:'select',required:true,options:members,show:()=>appCreate},{key:'organizationId',label:'归属组织',type:'select',required:true,options:organizations,show:()=>appCreate},
        ...(kind.startsWith('personal_')?moneyFields:quotaFields).filter(f=>!extension||f.key!=='amount').map(f=>({...f,label:f.key==='amount'&&['project_create','application_create','application_billing'].includes(kind)?'申请初始额度（CNY）':f.label,show:(v:FormValues)=>(!appCreate||v.billingMode==='quota')&&(!f.show||f.show(v))})),
        {key:'scenario',label:'使用场景',required:true},{key:'reason',label:'申请说明',type:'textarea',required:true}];
      edit(previous?'修改后重新申请':`申请${approvalLabels[kind]}`,fields,{name:previous?.proposedName??'',managerId:previous?.proposedManagerId??'',ownerId:previous?.proposedApplication?.ownerId??d.actor.id,organizationId:previous?.proposedApplication?.organizationId??d.actor.organizationId,billingMode:previous?.proposedApplication?.billingMode??'accounting',amount:previous?String(previous.amount):kind.startsWith('personal_')?'100':'',validity:previous?isPermanentQuota(previous.requestedExpiresAt)?'permanent':'dated':kind.startsWith('application_')?'permanent':'dated',expiresAt:previous&&!isPermanentQuota(previous.requestedExpiresAt)?toDateInput(previous.requestedExpiresAt):kind.startsWith('personal_')?defaultExpiry:'',scenario:previous?.scenario??'',reason:previous?.reason??''},'approval.submit',v=>({kind,objectId:objectId??null,batchId:batchId??previous?.requestedBatchId,name:v.name,managerId:v.managerId||null,ownerId:v.ownerId,organizationId:v.organizationId,billingMode:v.billingMode,amount:Number(v.amount),expiresAt:appCreate&&v.billingMode==='accounting'?QUOTA_FOREVER:readExpiry(v),scenario:v.scenario,reason:v.reason}),previous?'已带回原申请内容，原记录保留。':undefined,result=>{if(onSubmitted&&result&&typeof result==='object'&&'id' in result)onSubmitted(String(result.id));},v=>approvalFormContext(d,kind as ApprovalKind,objectId,v),'提交申请');
    },
    approve(approval:PlatformSnapshot['approvals'][number]){
      const fields:FieldSpec[]=[...approvalFields(approval),{key:'reason',label:'审批意见',type:'textarea',required:true}];
      if(approval.kind==='personal_open')fields.push({key:'planId',label:'确认开通方案',type:'select',required:true,options:d.plans.filter(p=>p.active).map(p=>option(p.id,p.name))});
      if(approval.kind==='application_create')fields.push(...rangeFields());
      if(approval.kind==='project_create')fields.push({key:'managerId',label:'确认项目经理',type:'select',required:true,options:members},...rangeFields());
      if(approval.kind==='project_member_quota')fields.push({key:'sourceBatchId',label:'项目来源批次',type:'select',required:true,options:d.projectBudgets.filter(b=>b.projectId===approval.objectId&&!b.closedAt&&b.availableAmount>0&&Date.parse(b.expiresAt)>Date.now()).map(b=>option(b.id,`${b.availableAmount} 元 · ${date(b.expiresAt)}`))});
      open({title:'批准并生效',submitLabel:'预览批准内容',context:v=>approvalFormContext(d,approval.kind,approval.objectId??undefined,v,approval),fields:relatedFields(fields,'approval.decide'),initial:{validity:isPermanentQuota(approval.requestedExpiresAt)?'permanent':'dated',amount:String(approval.amount),expiresAt:toDateInput(approval.requestedExpiresAt),reason:'',planId:'',managerId:approval.proposedManagerId??'',sourceBatchId:'',...rangeInitial(undefined,true)},rebuild:latest=>rebuildWith(latest,next=>{const current=latest.approvals.find(a=>a.id===approval.id);if(!current)throw new Error('当前申请已不在权限范围。');next.approve(current);}),submit:async v=>{
        const source=d.projectBudgets.find(b=>b.id===v.sourceBatchId);
        const result=await run('approval.decide',{id:approval.id,decision:'approve',amount:Number(v.amount),expiresAt:source?.expiresAt??(approval.kind==='application_create'&&approval.proposedApplication?.billingMode==='accounting'?QUOTA_FOREVER:readExpiry(v)),reason:v.reason,planId:v.planId||undefined,managerId:v.managerId||undefined,range:['project_create','application_create'].includes(approval.kind)?readRange(v):undefined,sourceBatchId:v.sourceBatchId||undefined});
        if(result===null)return false;await run('approval.execute',{id:approval.id},false).catch(()=>null);return true;
      }});
    },
    repairApproval(approval:PlatformSnapshot['approvals'][number]){
      const approvedExpiry=approval.approvedExpiresAt??approval.requestedExpiresAt;
      const execution=approval.execution??{},fields:FieldSpec[]=[...approvalFields(approval),{key:'reason',label:'修正依据及处理意见',type:'textarea',required:true}];
      if(approval.kind==='personal_open')fields.push({key:'planId',label:'确认开通方案',type:'select',required:true,options:d.plans.filter(p=>p.active).map(p=>option(p.id,p.name))});
      if(approval.kind==='application_create')fields.push(...rangeFields());
      if(approval.kind==='project_create')fields.push({key:'managerId',label:'项目经理',type:'select',required:true,options:members},...rangeFields());
      if(approval.kind==='project_member_quota')fields.push({key:'sourceBatchId',label:'项目来源批次（期限随批次）',type:'select',required:true,options:d.projectBudgets.filter(b=>b.projectId===approval.objectId&&!b.closedAt&&b.availableAmount>0&&Date.parse(b.expiresAt)>Date.now()).map(b=>option(b.id,`${b.availableAmount} 元 · ${date(b.expiresAt)}`))});
      edit('修正已批准事项的执行参数',fields,{validity:isPermanentQuota(approvedExpiry)?'permanent':'dated',amount:String(approval.approvedAmount??approval.amount),expiresAt:toDateInput(approval.approvedExpiresAt??approval.requestedExpiresAt),reason:'',planId:String(execution.planId??''),managerId:String(execution.managerId??approval.proposedManagerId??''),sourceBatchId:String(execution.sourceBatchId??''),...rangeInitial(execution.range as Parameters<typeof rangeInitial>[0],true)},'approval.repair',v=>({id:approval.id,amount:Number(v.amount),expiresAt:d.projectBudgets.find(b=>b.id===v.sourceBatchId)?.expiresAt??(approval.kind==='application_create'&&approval.proposedApplication?.billingMode==='accounting'?QUOTA_FOREVER:readExpiry(v)),reason:v.reason,planId:v.planId||undefined,managerId:v.managerId||undefined,sourceBatchId:v.sourceBatchId||undefined,range:['project_create','application_create'].includes(approval.kind)?readRange(v):undefined}),'保存后需单独执行生效；原批准与失败记录保留。',undefined,v=>approvalFormContext(d,approval.kind,approval.objectId??undefined,v,approval,true),'预览修正内容');
    },
    closeApproval(approval:PlatformSnapshot['approvals'][number]){edit('关闭未生效申请',[{key:'reason',label:'关闭原因',type:'textarea',required:true}],{reason:''},'approval.close',v=>({id:approval.id,reason:v.reason}),'关闭后不可再执行，可重新申请；原审批与失败记录保留。',undefined,undefined,'预览关闭影响',true);},
    reject(approvalId:string){edit('驳回申请',[{key:'reason',label:'驳回意见',type:'textarea',required:true}],{reason:''},'approval.decide',v=>({id:approvalId,decision:'reject',reason:v.reason}));},
    keyStatus(keyId:string,status:string){edit(status==='revoked'?'吊销密钥':'调整密钥状态',[{key:'reason',label:'处理原因',type:'textarea',required:true}],{reason:''},'key.status',v=>({id:keyId,status,reason:v.reason}));},
    keysStatus(ids:string[],status:'disabled'|'revoked'){edit(`${status==='revoked'?'批量吊销':'批量停用'} ${ids.length} 把密钥`,[{key:'reason',label:'处理原因',type:'textarea',required:true}],{reason:''},'keys.status',v=>({ids,status,reason:v.reason}),status==='revoked'?'下一步核对完整对象清单。吊销后无法恢复；需要继续接入时重新签发。':'下一步核对完整对象清单。停用后不接受新调用，需要时可逐把恢复；不改变用途额度。');},
    workspaceName(){edit('调整企业工作区名称',[{key:'name',label:'工作区显示名称',required:true,help:'最多 100 个字符。显示在登录后的页面顶部。'}],{name:d.settings.name},'settings.update',v=>{const name=String(v.name).trim();if(!name)throw new Error('请输入工作区名称，不能只填写空格。');if(name.length>100)throw new Error('工作区名称最多 100 个字符。');return {name};},'修改工作区展示名称，现有组织、账号和额度保留。');},
    defaults(){edit('默认模型池',[{key:'personalDefaultPoolId',label:'新个人方案默认池',type:'select',options:d.pools.map(p=>option(p.id,p.name))},{key:'projectDefaultPoolId',label:'新项目默认池',type:'select',options:d.pools.map(p=>option(p.id,p.name))}],{personalDefaultPoolId:d.settings.personalDefaultPoolId??'',projectDefaultPoolId:d.settings.projectDefaultPoolId??''},'settings.update',v=>({...v}),'仅影响后续新建或审批预填，不迁移已有权益，不发放资金。');},
    defaultLimits(){edit('企业默认使用保护',limitFields('defaults','默认保护方式'),limitInitial('defaults',d.settings.limits),'settings.update',v=>({limits:readLimits('defaults',v)}),'各适用对象分别继承默认值；主体、模型池、服务、模型入口和共享容量的计数范围不同，请按实际服务容量配置。');},
    retentionPolicy(){edit('调整通知与告警保留策略',[{key:'days',label:'已读通知与已恢复告警保留天数',type:'number',step:'1',required:true,help:'1–3650 天。缩短期限后，较早记录可能进入可清理范围。'},{key:'automatic',label:'执行方式',type:'select',required:true,options:[option('no','仅按需手动清理'),option('yes','开启每日自动清理')]},{key:'reason',label:'调整原因',type:'textarea',required:true}],{days:String(d.settings.retentionDays),automatic:d.settings.retentionAutomatic===true?'yes':'no',reason:''},'settings.retention',v=>{const days=Number(v.days);if(!Number.isInteger(days)||days<1||days>3650)throw new Error('保留天数请填写 1–3650 的整数。');return {days,automatic:v.automatic==='yes',reason:v.reason};},'下一步核对新策略及影响。账本、调用元数据、业务记录和操作审计继续保留；开启自动清理后，后台维护会按新策略执行。');},
  };
}
