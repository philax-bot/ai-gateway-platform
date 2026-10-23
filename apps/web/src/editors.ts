import { parseMemberImport, type AlertRule, type AutoRule, type Application, type CallLog, type Member, type ModelDefinition, type ModelPool, type ModelService, type Plan, type PlatformSnapshot, type Project } from '@ai-gateway/contracts';
import { endOfDay, toDateInput, type Editor, type FieldSpec, type FormValues, type RelatedResource } from './components';
import { limitFields,limitInitial,readLimits } from './limit-fields';
import { organizationPath,organizationTree } from './organizations';

export type RunCommand=(type:string,payload:Record<string,unknown>,confirm?:boolean)=>Promise<unknown|null>;
const option=(id:string,name:string)=>({value:id,label:name});
const values=(value:string|string[]|undefined)=>Array.isArray(value)?value:[];
export function makeEditors(d:PlatformSnapshot,run:RunCommand,open:(editor:Editor)=>void){
  const organizations=d.organizations.map(o=>option(o.id,organizationPath(d.organizations,o.id))),members=d.members.filter(m=>m.active).map(m=>option(m.id,m.name));
  const yesNo=[option('yes','启用'),option('no','停用')];
  const defaultExpiry=toDateInput(new Date(Date.now()+30*86400000).toISOString());
  function rebuildWith(latest:PlatformSnapshot,recipe:(next:ReturnType<typeof makeEditors>)=>void):Editor{
    let result:Editor|undefined;recipe(makeEditors(latest,run,next=>{result=next;}));if(!result)throw new Error('无法恢复原表单');return result;
  }
  function relatedFields(fields:FieldSpec[],type:string,topup=false):FieldSpec[]{
    const related:Record<string,RelatedResource>={poolId:{kind:'pool',label:'新建模型池，完成后返回'},personalDefaultPoolId:{kind:'pool',label:'新建模型池，完成后返回'},projectDefaultPoolId:{kind:'pool',label:'新建模型池，完成后返回'},planId:{kind:'plan',label:'新建开通方案，完成后返回'},organizationId:{kind:'organization',label:'新建组织，完成后返回'},managerId:{kind:'member',label:'新建项目经理账号，完成后返回'},ownerId:{kind:'member',label:'新建负责人账号，完成后返回'},sponsorId:{kind:'member',label:'新建内部责任人，完成后返回'}};
    return fields.map(field=>{
      if(!d.actor.roles.includes('operator'))return field;
      const create=field.key.startsWith('service:')?{kind:'service' as const,label:'新建模型服务并验证，完成后返回',definitionId:field.key.slice(8)}:type==='save.service'&&field.key==='definitionIds'?{kind:'definition' as const,label:'新建模型定义，完成后返回'}:topup?undefined:related[field.key];
      return {...field,create:field.create??create};
    });
  }
  function edit(title:string,fields:FieldSpec[],initial:FormValues,type:string,transform:(values:FormValues)=>Record<string,unknown>,description?:string,onSaved?:(value:unknown)=>void){
    const fieldSpecs=relatedFields(fields,type,type==='distribution.execute'&&transform(initial).operation==='topup');
    let saved:unknown;
    const editor:Editor={title,fields:fieldSpecs,initial,description,commandType:type,getResult:()=>saved,submitLabel:type==='save.service'?'保存模型服务':undefined,submit:async v=>{const result=await run(type,transform(v));if(result===null)return false;saved=result;onSaved?.(result);return true;}};
    const collections={'save.definition':'definitions','save.service':'services','save.pool':'pools','save.plan':'plans','save.organization':'organizations','save.member':'members','save.project':'projects','save.application':'applications','save.rule':'rules'} as const;
    if(type in collections){
      const collection=collections[type as keyof typeof collections],id=transform(initial).id;
      editor.rebuild=latest=>rebuildWith(latest,next=>{
        if(id&&!latest[collection].some(value=>value.id===id))throw new Error('原对象已删除或不在当前权限范围，不能恢复编辑。');
        switch(type){
          case 'save.definition':next.definition(latest.definitions.find(v=>v.id===id));break;
          case 'save.service':next.service(latest.services.find(v=>v.id===id));break;
          case 'save.pool':next.pool(latest.pools.find(v=>v.id===id));break;
          case 'save.plan':next.plan(latest.plans.find(v=>v.id===id));break;
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
    {key:'definitionIds',label:'指定模型',type:'multiple',options:d.definitions.map(m=>option(m.id,m.name)),show:v=>v.rangeMode==='specific',help:'仅选择当前池内模型；后续新增模型不会自动扩大本范围。'},
  ];}
  const readRange=(v:FormValues)=>({poolId:String(v.poolId),mode:String(v.rangeMode),definitionIds:v.rangeMode==='specific'?values(v.definitionIds):[]});
  const rangeInitial=(r?:{poolId:string;mode:string;definitionIds:string[]},project=false):FormValues=>({poolId:r?.poolId??(project?d.settings.projectDefaultPoolId:d.settings.personalDefaultPoolId)??'',rangeMode:r?.mode??'follow',definitionIds:r?.definitionIds??[]});
  const moneyFields:FieldSpec[]=[{key:'amount',label:'金额（CNY）',type:'number',required:true},{key:'expiresAt',label:'有效日期（北京时间，当日结束）',type:'date',required:true}];
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
      const metrics=[option('upstream_failure_rate','上游故障率 / 已转发且已结束'),option('request_error_rate','请求错误率 / 全部已结束'),option('timeout_rate','超时率 / 全部已结束'),option('stream_failure_rate','部分 / 流式异常率 / 全部已结束'),option('rate_limit_rate','限流拒绝率 / 全部已结束'),option('cancellation_rate','客户端取消率 / 全部已结束')];
      edit(existing?'编辑告警规则':'创建告警规则',[
        {key:'name',label:'规则名称',required:true},{key:'serviceId',label:'服务范围（留空为全部）',type:'select',options:d.services.map(s=>option(s.id,s.name))},{key:'modelId',label:'模型范围（留空为全部）',type:'select',options:d.definitions.map(m=>option(m.modelId,m.name))},
        {key:'metric',label:'指标与分母',type:'select',required:true,options:metrics},
        ...[['windowMinutes','统计窗口（分钟，1–60）'],['threshold','触发阈值（%），实际值 ≥ 阈值'],['minSamples','最小样本数'],['triggerCount','连续触发次数'],['recoveryThreshold','恢复阈值（%），实际值 < 阈值'],['recoveryCount','连续恢复次数']].map(([key,label])=>({key,label,type:'number' as const,required:true})),
        {key:'active',label:'后续新事件',type:'select',options:[option('yes','启用'),option('no','暂停产生新事件')]},
      ],{name:existing?.name??'上游故障率',serviceId:existing?.serviceId??'',modelId:existing?.modelId??'',metric:existing?.metric??'upstream_failure_rate',windowMinutes:String(existing?.windowMinutes??5),threshold:String(existing?.threshold??10),minSamples:String(existing?.minSamples??20),triggerCount:String(existing?.triggerCount??2),recoveryThreshold:String(existing?.recoveryThreshold??5),recoveryCount:String(existing?.recoveryCount??2),active:existing?.active===false?'no':'yes'},'save.alert-rule',v=>({id:existing?.id,name:v.name,serviceId:v.serviceId||null,modelId:v.modelId||null,metric:v.metric,active:v.active==='yes',...Object.fromEntries(['windowMinutes','threshold','minSamples','triggerCount','recoveryThreshold','recoveryCount'].map(key=>[key,Number(v[key])]))}),'每分钟评估一个完整时间窗口。示例阈值尚未经过生产容量验证，请按实际调整。无流量、样本不足或采集失败不会解除告警。已有事件保留触发时规则直到恢复，修改配置仅影响后续新事件。');
    },
    reconcile(log:CallLog){
      edit('核对调用费用',[{key:'mode',label:'核对结果',type:'select',required:true,options:[option('confirm_usage','根据已确认的完整用量结算'),option('release_hold','确认不计费，释放预占')]},
        {key:'inputTokens',label:'已确认输入 Token（含缓存子集）',type:'number',required:true,show:v=>v.mode==='confirm_usage'},
        {key:'outputTokens',label:'已确认输出 Token',type:'number',required:true,show:v=>v.mode==='confirm_usage'},
        {key:'cachedInputTokens',label:'其中缓存输入 Token',type:'number',required:true,show:v=>v.mode==='confirm_usage'},
        {key:'reason',label:'依据与处理说明',type:'textarea',required:true}],{mode:'',inputTokens:log.usageFinal?String(log.inputTokens):'',outputTokens:log.usageFinal?String(log.outputTokens):'',cachedInputTokens:log.usageFinal?String(log.cachedInputTokens):'0',reason:''},'usage.reconcile',v=>({requestId:log.requestId,mode:v.mode,reason:v.reason,...(v.mode==='confirm_usage'?{inputTokens:Number(v.inputTokens),outputTokens:Number(v.outputTokens),cachedInputTokens:Number(v.cachedInputTokens)}:{})}),`请求 ${log.requestId}。费用使用原预占时的价格；超出预占部分只能从同一原始批次补扣，余额不足时保持待核对。`);
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
        {key:'roles',label:'职责',type:'multiple',group:'账户与职责（按需调整）',options:[option('employee','员工'),option('operator','运营管理员')]},
        {key:'sponsorId',label:'内部责任人',type:'select',required:true,options:members,show:v=>v.category==='contractor'},
        {key:'validUntil',label:'人员有效日期',type:'date',requiredWhen:v=>v.category==='contractor',help:'外部人员必须填写；个人密钥不能超出人员有效期。'},
        {key:'active',label:'状态',type:'select',group:'账户与职责（按需调整）',options:yesNo},
        ...limitFields('member','人员使用限制'),
        {key:'password',label:existing?'设置新密码（留空保留）':'首次登录密码',type:'password',group:existing?'账户与职责（按需调整）':undefined,required:!existing,help:'至少 12 位。密码不会出现在成员列表和审计中。'},
      ],{name:existing?.name??'',directoryId:existing?.directoryId??'',organizationId:existing?.organizationId??d.actor.organizationId,category:existing?.category??'employee',tags:existing?.tags?.join(', ')??'',roles:existing?.roles??['employee'],sponsorId:existing?.sponsorId??'',validUntil:toDateInput(existing?.validUntil),active:existing?.active===false?'no':'yes',password:'',...limitInitial('member',existing?.limits)},'save.member',v=>({id:existing?.id,name:v.name,directoryId:v.directoryId,organizationId:v.organizationId,category:v.category,password:v.password,tags:String(v.tags).split(',').map(s=>s.trim()).filter(Boolean),roles:values(v.roles),active:v.active==='yes',validUntil:v.validUntil?endOfDay(v.validUntil):null,sponsorId:v.sponsorId||null,limits:readLimits('member',v)}));
    },
    definition(existing?:ModelDefinition){
      edit(existing?'编辑模型定义':'创建模型定义',[{key:'name',label:'显示名称',required:true},{key:'modelId',label:'对外模型标识',required:true},{key:'contextTokens',label:'单次上下文 Token',type:'number',required:true},{key:'description',label:'能力说明',type:'textarea'},{key:'active',label:'状态',type:'select',options:yesNo}],{name:existing?.name??'',modelId:existing?.modelId??'',contextTokens:String(existing?.contextTokens??32768),description:existing?.description??'',active:existing?.active===false?'no':'yes'},'save.definition',v=>({id:existing?.id,...v,contextTokens:Number(v.contextTokens),active:v.active==='yes'}));
    },
    service(existing?:ModelService,definitionId?:string){
      const fields:FieldSpec[]=[{key:'name',label:'服务名称',required:true},{key:'baseUrl',label:'服务地址',required:true,help:'HTTP(S) 地址，不包含用户名、密码、查询参数。'},{key:'credentialRef',label:'受控凭据引用（可选）',help:'填写服务端已配置的 UPSTREAM_ 环境变量名称，勿填写密钥明文。'},{key:'active',label:'服务状态',type:'select',options:yesNo,group:'服务状态与共享容量（按需调整）'},...limitFields('service','服务整体保护'),{key:'sharedCapacityId',label:'共享容量标识（可选）',group:'服务状态与共享容量（按需调整）',help:'同一标识的服务共用默认容量保护，不因分到不同模型池而获得额外算力。'},{key:'definitionIds',label:'提供的模型',type:'multiple',required:true,options:d.definitions.map(m=>option(m.id,m.name))}];
      const initial:FormValues={name:existing?.name??'',baseUrl:existing?.baseUrl??'',credentialRef:existing?.credentialRef??'',active:existing?.active===false?'no':'yes',definitionIds:existing?.mappings.map(m=>m.definitionId)??(definitionId?[definitionId]:[]),sharedCapacityId:existing?.sharedCapacityId??'',...limitInitial('service',existing?.limits)};
      for(const definition of d.definitions){
        const mapping=existing?.mappings.find(m=>m.definitionId===definition.id),show=(v:FormValues)=>values(v.definitionIds).includes(definition.id);
        fields.push({key:`upstream:${definition.id}`,label:`${definition.name} · 上游标识`,required:true,show},...(['input','output','cachedInput'] as const).map((kind,index)=>({key:`${kind}:${definition.id}`,label:`${definition.name} · ${['输入','输出','缓存输入'][index]}价格（元 / 百万 Token）`,type:'number' as const,show,help:'免费填 0；未知留空，不会当作免费。'})));
        initial[`upstream:${definition.id}`]=mapping?.upstreamModel??definition.modelId;
        initial[`input:${definition.id}`]=mapping?.inputPrice?.toString()??'';initial[`output:${definition.id}`]=mapping?.outputPrice?.toString()??'';initial[`cachedInput:${definition.id}`]=mapping?.cachedInputPrice?.toString()??'';
        fields.push(...limitFields(`mapping:${definition.id}`,`${definition.name} · 模型入口保护`,show));Object.assign(initial,limitInitial(`mapping:${definition.id}`,mapping?.limits));
      }
      edit(existing?'编辑模型服务':'接入模型服务',fields,initial,'save.service',v=>({id:existing?.id,name:v.name,baseUrl:v.baseUrl,credentialRef:v.credentialRef||null,active:v.active==='yes',limits:readLimits('service',v),sharedCapacityId:v.sharedCapacityId||null,mappings:values(v.definitionIds).map(definitionId=>({definitionId,upstreamModel:v[`upstream:${definitionId}`],inputPrice:v[`input:${definitionId}`]===''?null:Number(v[`input:${definitionId}`]),outputPrice:v[`output:${definitionId}`]===''?null:Number(v[`output:${definitionId}`]),cachedInputPrice:v[`cachedInput:${definitionId}`]===''?null:Number(v[`cachedInput:${definitionId}`]),limits:readLimits(`mapping:${definitionId}`,v)}))}),'保存与验证分开。连接或映射变更后需重新验证；价格变化只影响新准入的请求，历史调用使用原价格。');
    },
    pool(existing?:ModelPool){
      const fields:FieldSpec[]=[{key:'name',label:'模型池名称',required:true},...limitFields('pool','模型池总保护')],initial:FormValues={name:existing?.name??'',...limitInitial('pool',existing?.limits)};
      for(const definition of d.definitions){
        const entry=existing?.entries.find(e=>e.definitionId===definition.id);
        fields.push({key:`service:${definition.id}`,label:`${definition.name} · 唯一来源`,type:'select',options:[option('','不加入'),...d.services.filter(s=>s.mappings.some(m=>m.definitionId===definition.id)).map(s=>option(s.id,`${s.name} · ${s.verification==='passed'?'已验证':'未通过验证'}`))]},
          {key:`open:${definition.id}`,label:`${definition.name} · 是否开放`,type:'select',options:[option('no','已加入，暂不开放'),option('yes','开放使用')],show:v=>!!v[`service:${definition.id}`]});
        initial[`service:${definition.id}`]=entry?.serviceId??'';initial[`open:${definition.id}`]=entry?.open?'yes':'no';
      }
      edit(existing?'调整模型池':'创建模型池',fields,initial,'save.pool',v=>({id:existing?.id,name:v.name,limits:readLimits('pool',v),entries:d.definitions.filter(def=>!!v[`service:${def.id}`]).map(def=>({definitionId:def.id,serviceId:v[`service:${def.id}`],open:v[`open:${def.id}`]==='yes'}))}),'跟随模式的权益会同步开放范围；指定模式不自动扩大。变更不会转移任何资金。');
    },
    plan(existing?:Plan){
      edit(existing?'编辑个人方案模板':'创建个人开通方案',[{key:'name',label:'方案名称',required:true},...rangeFields(),{key:'amount',label:'每次发放金额（CNY）',type:'number',required:true},{key:'cadence',label:'发放周期',type:'select',options:[option('once','一次性'),option('monthly','每月，不结转')]},{key:'quotaDays',label:'一次性额度有效天数',type:'number',required:true,show:v=>v.cadence==='once'},{key:'entitlementDays',label:'模型权益有效天数',type:'number',required:true},...limitFields('plan','方案默认保护'),{key:'active',label:'方案状态',type:'select',options:yesNo}],{name:existing?.name??'',...rangeInitial(existing?.range),...limitInitial('plan',existing?.limits),active:existing?.active===false?'no':'yes',amount:String(existing?.amount??100),cadence:existing?.cadence??'monthly',quotaDays:String(existing?.quotaDays??30),entitlementDays:String(existing?.entitlementDays??365)},'save.plan',v=>({id:existing?.id,name:v.name,range:readRange(v),amount:Number(v.amount),cadence:v.cadence,active:v.active==='yes',quotaDays:Number(v.quotaDays),entitlementDays:Number(v.entitlementDays),limits:readLimits('plan',v)}),'修改模板产生新版本，已授予权益保留授予时版本；不会静默迁移存量人员。');
    },
    grantPlan(planId?:string,memberId?:string){
      distribute(false,planId,memberId);
    },
    topup(planId?:string,memberId?:string){distribute(true,planId,memberId);},
    project(existing?:Project){
      edit(existing?'编辑项目':'创建项目',[{key:'name',label:'项目名称',required:true},{key:'description',label:'业务说明',type:'textarea'},{key:'managerId',label:'项目经理',type:'select',required:true,options:members},...rangeFields(),...limitFields('project','项目整体保护'),{key:'status',label:'项目状态',type:'select',options:[option('active','启用'),option('paused','暂停')]}],{name:existing?.name??'',description:existing?.description??'',managerId:existing?.managerId??'',...rangeInitial(existing?.range,true),...limitInitial('project',existing?.limits),status:existing?.status??'active'},'save.project',v=>({id:existing?.id,name:v.name,description:v.description,managerId:v.managerId,range:readRange(v),status:v.status,limits:readLimits('project',v)}),'创建项目不会产生预算。下一步发放项目总额度、添加成员，再从来源批次分配给成员。');
    },
    projectMembers(project:Project){edit('添加项目成员',[{key:'memberIds',label:'有效企业成员',type:'multiple',required:true,options:members.filter(m=>!project.memberIds.includes(m.value))}],{memberIds:[]},'project.members',v=>({projectId:project.id,memberIds:values(v.memberIds)}),'加入项目只建立成员关系，不自动发放额度。');},
    endProject(project:Project){edit('结束项目并回收未使用余额',[{key:'reason',label:'结束依据',type:'textarea',required:true}],{reason:''},'project.end',v=>({projectId:project.id,reason:v.reason}),'结束为终态。未分配预算与成员未使用余额进入结束回收记录，不转入个人或其他项目。已准入请求按原来源继续结算，后续释放预占也进入回收金额。');},
    fund(kind:'project'|'application',object:Project|Application){edit(`向${kind==='project'?'项目':'应用'}发放额度`,moneyFields,{amount:'100',expiresAt:defaultExpiry},`${kind}.fund`,v=>({[kind==='project'?'projectId':'applicationId']:object.id,amount:Number(v.amount),expiresAt:endOfDay(v.expiresAt)}),`${object.name} · 每次发放形成独立批次，保留原有期限。`);},
    allocate(project:Project,memberId?:string){
      const budgets=d.projectBudgets.filter(b=>b.projectId===project.id&&!b.closedAt&&b.availableAmount>0&&Date.parse(b.expiresAt)>Date.now()).sort((a,b)=>Date.parse(a.expiresAt)-Date.parse(b.expiresAt)||a.id.localeCompare(b.id));
      edit('分配项目成员额度',[{key:'sourceBatchId',label:'项目来源批次',type:'select',required:true,options:budgets.map(b=>option(b.id,`${b.availableAmount} 元待分配 · ${toDateInput(b.expiresAt)} 到期`))},{key:'memberId',label:'项目成员',type:'select',required:true,options:members.filter(m=>project.memberIds.includes(m.value))},{key:'amount',label:'分配金额（CNY）',type:'number',required:true}],{sourceBatchId:budgets[0]?.id??'',memberId:memberId??'',amount:''},'project.allocate',v=>({projectId:project.id,sourceBatchId:v.sourceBatchId,memberId:v.memberId,amount:Number(v.amount)}),'从选定的项目批次转为成员可用额度，继承到期日，不会再次为项目充值。');
    },
    application(existing?:Application){edit(existing?'编辑应用':'创建独立应用',[{key:'name',label:'应用名称',required:true},{key:'ownerId',label:'应用负责人',type:'select',required:true,options:members},{key:'organizationId',label:'归属组织',type:'select',required:true,options:organizations},{key:'description',label:'接入用途',type:'textarea'},...rangeFields(),...limitFields('application','应用整体保护'),{key:'active',label:'状态',type:'select',options:yesNo}],{name:existing?.name??'',ownerId:existing?.ownerId??'',organizationId:existing?.organizationId??'org-demo',description:existing?.description??'',...rangeInitial(existing?.range),...limitInitial('application',existing?.limits),active:existing?.active===false?'no':'yes'},'save.application',v=>({id:existing?.id,name:v.name,ownerId:v.ownerId,organizationId:v.organizationId,description:v.description,range:readRange(v),active:v.active==='yes',limits:readLimits('application',v)}),'应用独立使用额度和凭据，不需要关联项目，也不借用负责人的个人余额。');},
    key(initialPurpose:'personal'|'project'|'application'='personal',objectId?:string){
      const bound=!!objectId&&initialPurpose!=='personal',name=initialPurpose==='application'?d.applications.find(a=>a.id===objectId)?.name:d.projects.find(p=>p.id===objectId)?.name;
      const fields:FieldSpec[]=[{key:'name',label:'密钥名称',required:true}];
      if(!bound)fields.push({key:'purpose',label:'扣费用途',type:'select',required:true,options:[option('personal','个人 · 日常办公'),option('project','项目成员'),...(d.applications.length?[option('application','独立应用')]:[])]},{key:'projectId',label:'项目',type:'select',options:d.projects.filter(p=>p.memberIds.includes(d.actor.id)&&p.status==='active').map(p=>option(p.id,p.name)),show:v=>v.purpose==='project'},{key:'applicationId',label:'应用',type:'select',options:d.applications.filter(a=>a.active).map(a=>option(a.id,a.name)),show:v=>v.purpose==='application'});
      fields.push({key:'expiresAt',label:'到期日期',type:'date',required:true});
      edit(bound?`为${name??'当前用途'}签发密钥`:'签发用途密钥',fields,{name:bound?`${name??'当前用途'}接入`:'',purpose:initialPurpose,projectId:initialPurpose==='project'?objectId??'':'',applicationId:initialPurpose==='application'?objectId??'':'',expiresAt:toDateInput(new Date(Date.now()+90*86400000).toISOString())},'key.issue',v=>({name:v.name,purpose:bound?initialPurpose:v.purpose,projectId:bound?initialPurpose==='project'?objectId:null:v.projectId||null,applicationId:bound?initialPurpose==='application'?objectId:null:v.applicationId||null,expiresAt:endOfDay(v.expiresAt)}),`${bound?`已绑定 ${name??'当前用途'}。`:''}完整值只在签发成功时显示一次。多把密钥共享该用途的额度与限制。`);
    },
    request(kind:string,objectId?:string,previous?:PlatformSnapshot['approvals'][number],onSubmitted?:(id:string)=>void){
      edit(previous?'修改后重新申请':'提交申请',[{key:'name',label:'项目名称',required:true,show:()=>kind==='project_create'},{key:'managerId',label:'建议项目经理',type:'select',options:members,show:()=>kind==='project_create'},...moneyFields.filter(f=>f.key!=='amount'||kind!=='project_create'),{key:'scenario',label:'使用场景',required:true},{key:'reason',label:'申请说明',type:'textarea',required:true}],{name:previous?.proposedName??'',managerId:previous?.proposedManagerId??'',amount:String(previous?.amount??100),expiresAt:previous&&Date.parse(previous.requestedExpiresAt)>Date.now()?toDateInput(previous.requestedExpiresAt):defaultExpiry,scenario:previous?.scenario??'',reason:previous?.reason??''},'approval.submit',v=>({kind,objectId:objectId??null,name:v.name,managerId:v.managerId||null,amount:Number(v.amount),expiresAt:endOfDay(v.expiresAt),scenario:v.scenario,reason:v.reason}),previous?'已带回原申请内容。请按处理意见调整；提交会创建新申请，原申请及处理记录保留。':'申请会进入统一审批中心。个人和项目创建申请无需选择模型池。',result=>{if(onSubmitted&&result&&typeof result==='object'&&'id' in result)onSubmitted(String(result.id));});
    },
    approve(approval:PlatformSnapshot['approvals'][number]){
      const fields:FieldSpec[]=[...moneyFields.filter(f=>(f.key!=='amount'||approval.kind!=='project_create')&&(f.key!=='expiresAt'||approval.kind!=='project_member_quota')),{key:'reason',label:'审批意见',type:'textarea',required:true}];
      if(approval.kind==='personal_open')fields.push({key:'planId',label:'确认开通方案',type:'select',required:true,options:d.plans.map(p=>option(p.id,p.name))});
      if(approval.kind==='project_create')fields.push({key:'managerId',label:'确认项目经理',type:'select',required:true,options:members},...rangeFields());
      if(approval.kind==='project_member_quota')fields.push({key:'sourceBatchId',label:'项目来源批次',type:'select',required:true,options:d.projectBudgets.filter(b=>b.projectId===approval.objectId&&!b.closedAt&&b.availableAmount>0&&Date.parse(b.expiresAt)>Date.now()).map(b=>option(b.id,`${b.availableAmount} 元 · ${toDateInput(b.expiresAt)} 到期`))});
      open({title:'审批并执行',description:`申请金额 ${approval.amount} 元。批准值可调整；批准和生效分别记录。${approval.kind==='project_member_quota'?'额度期限沿用所选项目预算。':''}`,fields:relatedFields(fields,'approval.decide'),initial:{amount:String(approval.amount),expiresAt:toDateInput(approval.requestedExpiresAt),reason:'',planId:'',managerId:approval.proposedManagerId??'',sourceBatchId:'',...rangeInitial(undefined,true)},rebuild:latest=>rebuildWith(latest,next=>{const current=latest.approvals.find(a=>a.id===approval.id);if(!current)throw new Error('当前申请已不在权限范围。');next.approve(current);}),submit:async v=>{
        const source=d.projectBudgets.find(b=>b.id===v.sourceBatchId);
        const result=await run('approval.decide',{id:approval.id,decision:'approve',amount:Number(v.amount),expiresAt:source?.expiresAt??endOfDay(v.expiresAt),reason:v.reason,planId:v.planId||undefined,managerId:v.managerId||undefined,range:approval.kind==='project_create'?readRange(v):undefined,sourceBatchId:v.sourceBatchId||undefined});
        if(result===null)return false;await run('approval.execute',{id:approval.id},false).catch(()=>null);return true;
      }});
    },
    repairApproval(approval:PlatformSnapshot['approvals'][number]){
      const approvedExpiry=approval.approvedExpiresAt??approval.requestedExpiresAt;
      const execution=approval.execution??{},fields:FieldSpec[]=[...moneyFields.filter(f=>(f.key!=='amount'||approval.kind!=='project_create')&&(f.key!=='expiresAt'||approval.kind!=='project_member_quota')),{key:'reason',label:'修正依据及处理意见',type:'textarea',required:true}];
      if(approval.kind==='personal_open')fields.push({key:'planId',label:'确认开通方案',type:'select',required:true,options:d.plans.filter(p=>p.active).map(p=>option(p.id,p.name))});
      if(approval.kind==='project_create')fields.push({key:'managerId',label:'项目经理',type:'select',required:true,options:members},...rangeFields());
      if(approval.kind==='project_member_quota')fields.push({key:'sourceBatchId',label:'项目来源批次（期限随批次）',type:'select',required:true,options:d.projectBudgets.filter(b=>b.projectId===approval.objectId&&!b.closedAt&&b.availableAmount>0&&Date.parse(b.expiresAt)>Date.now()).map(b=>option(b.id,`${b.availableAmount} 元 · ${toDateInput(b.expiresAt)} 到期`))});
      edit('修正已批准事项的执行参数',fields,{amount:String(approval.approvedAmount??approval.amount),expiresAt:toDateInput(approval.approvedExpiresAt??approval.requestedExpiresAt),reason:'',planId:String(execution.planId??''),managerId:String(execution.managerId??approval.proposedManagerId??''),sourceBatchId:String(execution.sourceBatchId??''),...rangeInitial(execution.range as Parameters<typeof rangeInitial>[0],true)},'approval.repair',v=>({id:approval.id,amount:Number(v.amount),expiresAt:d.projectBudgets.find(b=>b.id===v.sourceBatchId)?.expiresAt??(String(v.expiresAt)===toDateInput(approvedExpiry)?approvedExpiry:endOfDay(v.expiresAt)),reason:v.reason,planId:v.planId||undefined,managerId:v.managerId||undefined,sourceBatchId:v.sourceBatchId||undefined,range:approval.kind==='project_create'?readRange(v):undefined}),'本次修正保留原申请、原决定及失败记录；日期不变时保留原准确到期时间。确认后回到已批准待生效，再单独执行；当前审批责任人会登记为修正批准人。');
    },
    reject(approvalId:string){edit('驳回申请',[{key:'reason',label:'驳回意见',type:'textarea',required:true}],{reason:''},'approval.decide',v=>({id:approvalId,decision:'reject',reason:v.reason}));},
    keyStatus(keyId:string,status:string){edit(status==='revoked'?'吊销密钥':'调整密钥状态',[{key:'reason',label:'处理原因',type:'textarea',required:true}],{reason:''},'key.status',v=>({id:keyId,status,reason:v.reason}));},
    keysStatus(ids:string[],status:'disabled'|'revoked'){edit(`${status==='revoked'?'批量吊销':'批量停用'} ${ids.length} 把密钥`,[{key:'reason',label:'处理原因',type:'textarea',required:true}],{reason:''},'keys.status',v=>({ids,status,reason:v.reason}),status==='revoked'?'下一步核对完整对象清单。吊销后无法恢复；需要继续接入时重新签发。':'下一步核对完整对象清单。停用后不接受新调用，需要时可逐把恢复；不改变用途额度。');},
    workspaceName(){edit('调整企业工作区名称',[{key:'name',label:'工作区显示名称',required:true,help:'最多 100 个字符。显示在登录后的页面顶部。'}],{name:d.settings.name},'settings.update',v=>{const name=String(v.name).trim();if(!name)throw new Error('请输入工作区名称，不能只填写空格。');if(name.length>100)throw new Error('工作区名称最多 100 个字符。');return {name};},'修改工作区展示名称，现有组织、账号和额度保留。');},
    defaults(){edit('默认模型池',[{key:'personalDefaultPoolId',label:'新个人方案默认池',type:'select',options:d.pools.map(p=>option(p.id,p.name))},{key:'projectDefaultPoolId',label:'新项目默认池',type:'select',options:d.pools.map(p=>option(p.id,p.name))}],{personalDefaultPoolId:d.settings.personalDefaultPoolId??'',projectDefaultPoolId:d.settings.projectDefaultPoolId??''},'settings.update',v=>({...v}),'仅影响后续新建或审批预填，不迁移已有权益，不发放资金。');},
    defaultLimits(){edit('企业默认使用保护',limitFields('defaults','默认保护方式'),limitInitial('defaults',d.settings.limits),'settings.update',v=>({limits:readLimits('defaults',v)}),'各适用对象分别继承默认值；主体、模型池、服务、模型入口和共享容量的计数范围不同，请按实际服务容量配置。');},
    retentionPolicy(){edit('调整通知与告警保留策略',[{key:'days',label:'已读通知与已恢复告警保留天数',type:'number',step:'1',required:true,help:'1–3650 天。缩短期限后，较早记录可能进入可清理范围。'},{key:'automatic',label:'执行方式',type:'select',required:true,options:[option('no','仅按需手动清理'),option('yes','开启每日自动清理')]},{key:'reason',label:'调整原因',type:'textarea',required:true}],{days:String(d.settings.retentionDays),automatic:d.settings.retentionAutomatic===true?'yes':'no',reason:''},'settings.retention',v=>{const days=Number(v.days);if(!Number.isInteger(days)||days<1||days>3650)throw new Error('保留天数请填写 1–3650 的整数。');return {days,automatic:v.automatic==='yes',reason:v.reason};},'下一步核对新策略及影响。账本、调用元数据、业务记录和操作审计继续保留；开启自动清理后，后台维护会按新策略执行。');},
  };
}
