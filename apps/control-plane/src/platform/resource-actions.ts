import {frozenServiceCredential,saveUpstreamCredential} from './upstream-credentials';
import {mappingPrices,modelMultiplier} from './model-pricing';
import {authorizeCommand} from './command-authorization';
import {ROLE_LABELS} from '@ai-gateway/contracts';
import {modelKind,modalityPaths,poolRouting} from './model-configuration';
import {modelProviders,type ModelProvider} from '@ai-gateway/contracts';
import {quotaExpiry,now} from './validation';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { AutoRule, Member, ModelService, Plan,WorkspaceState } from '@ai-gateway/contracts';
import type { WorkspaceTransaction } from './workspace.repository';
import { activeMember, availableModels, expiry, limits, operator, passwordHash, pick, range, strings, text, amount } from './validation';
import { endProject,grantPlan, manager, matches, newId, owner, publicMember, valid } from './domain';
import { saveAlertRule } from './monitoring.domain';
import { applyAutomatic } from './automatic-onboarding';
import { prepareOrganizationChange } from './organization-changes';
import { applicationBillingMode, MODEL_CAPABILITIES, type ModelCapability, type ApplicationBillingMode } from '@ai-gateway/contracts';

export function memberCandidate(s:WorkspaceState,p:Record<string,unknown>,withPassword=true){
  const existing=p.id?pick(s.members,p.id,'member'):null,directoryId=text(p.directoryId,'directoryId',100);
  if(s.members.some(m=>m.directoryId===directoryId&&m.id!==existing?.id))throw new ConflictException('directory ID must be unique');
  const organization=pick(s.organizations,p.organizationId,'organization');
  const category=p.category??'employee';if(category!=='employee'&&category!=='contractor')throw new BadRequestException('invalid member category');
  const roles=strings(p.roles??existing?.roles??['employee'],'roles');if(roles.some(role=>!Object.hasOwn(ROLE_LABELS,role)))throw new BadRequestException('invalid role');
  const sponsorId=p.sponsorId?text(p.sponsorId,'sponsorId'):null;
  if(category==='contractor'){if(!sponsorId||!p.validUntil)throw new BadRequestException('contractor requires sponsor and expiry');const sponsor=activeMember(s,sponsorId);if(sponsor.category!=='employee')throw new BadRequestException('sponsor must be an internal employee');}
  let validUntil:string|null=null;if(p.validUntil){if(typeof p.validUntil!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(p.validUntil)||!Number.isFinite(Date.parse(p.validUntil)))throw new BadRequestException('invalid member expiry timestamp');validUntil=new Date(p.validUntil).toISOString();}
  const member:Member={id:existing?.id??newId('member'),name:text(p.name,'name',100),directoryId,organizationId:organization.id,category,tags:strings(p.tags??[],'tags'),roles:roles as Member['roles'],active:p.active!==false,validUntil,sponsorId,passwordHash:existing?.passwordHash,limits:p.limits?limits(p.limits):existing?.limits??{mode:'inherit'}};
  if(p.password){const password=text(p.password,'password',256);if(password.length<12)throw new BadRequestException('password must contain 12 to 256 characters');if(withPassword)member.passwordHash=passwordHash(password);}
  if(existing?.roles.includes('operator')&&(!member.active||!member.roles.includes('operator'))&&!s.members.some(m=>m.id!==existing.id&&m.active&&m.roles.includes('operator')&&valid(m.validUntil)))throw new ConflictException('cannot disable the last active operator');
  const prospective={...s,members:[...s.members.filter(m=>m.id!==member.id),member]};
  if(!prospective.members.some(m=>{try{return m.roles.includes('operator')&&!!activeMember(prospective,m.id);}catch{return false;}}))throw new ConflictException('member change would disable every operator');
  return member;
}
export async function saveMember(tx:WorkspaceTransaction,actor:Member,p:Record<string,unknown>,trigger='member.saved'){
  operator(actor);const s=tx.state,member=memberCandidate(s,p),existing=s.members.find(m=>m.id===member.id);
  if(existing)Object.assign(existing,member);else s.members.push(member);
  if(!member.active)await tx.disableCredentials(member.id);
  await applyAutomatic(tx,[member.id],actor.id,trigger);
  return publicMember(member);
}

export async function resourceAction(tx:WorkspaceTransaction,actor:Member,type:string,p:Record<string,unknown>):Promise<unknown>{
  const s=tx.state;
  authorizeCommand(s,actor,{type,payload:p,idempotencyKey:'resource-validation'});
  switch(type){
    case 'save.alert-rule':return saveAlertRule(s,p);
    case 'save.organization':{
      const prepared=prepareOrganizationChange(s,p),org=prepared.organization,existing=s.organizations.find(o=>o.id===org.id);
      if(existing)Object.assign(existing,org);else s.organizations.push(org);
      if(prepared.rematches)await applyAutomatic(tx,prepared.memberIds,actor.id,'organization.changed');
      s.audit.push({id:newId('audit'),actorId:actor.id,action:'organization.impact',objectId:org.id,reason:prepared.rematches?'组织归属或状态变更，重新匹配下级成员':'组织创建或名称调整',createdAt:new Date().toISOString(),detail:prepared.impact});
      return org;
    }
    case 'save.member':return saveMember(tx,actor,p);
    case 'import.members':{
      const rows=memberImportRows(s,p.rows);
      const results=[];
      for(const row of rows)results.push(await saveMember(tx,actor,row,'members.imported'));
      return {members:results};
    }
    case 'save.provider':{
      const custom=s.providers??=[],existing=p.id?modelProviders(custom).find(v=>v.id===p.id):undefined;
      if(p.id&&!existing)throw new BadRequestException('provider not found');
      const id=existing?.id??newId('provider'),adapter=String(p.adapter??'openai');
      if(!['openai','cohere','xai','volcengine'].includes(adapter))throw new BadRequestException('invalid provider adapter');
      const kinds=strings(p.kinds,'kinds').map(modelKind);if(!kinds.length)throw new BadRequestException('provider kinds required');
      let baseUrl='';if(p.baseUrl){let u:URL;try{u=new URL(String(p.baseUrl));}catch{throw new BadRequestException('invalid provider URL');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new BadRequestException('invalid provider URL');baseUrl=u.toString().replace(/\/$/,'');}
      const value:ModelProvider={id,name:text(p.name,'name',100),description:String(p.description??'').slice(0,1000),baseUrl,adapter:adapter as ModelProvider['adapter'],kinds,active:p.active!==false};
      s.providers=[...custom.filter(v=>v.id!==id),value];
      if(existing&&(existing.adapter!==value.adapter||JSON.stringify(existing.kinds)!==JSON.stringify(value.kinds)))for(const service of s.services.filter(v=>(v.providerId??'openai-compatible')===id)){service.configVersion++;service.verification='unverified';service.protocolCapabilities=undefined;service.verificationMessage='供应商能力或适配方式已更改，需要重新验证';}
      return value;
    }
    case 'delete.provider':{
      const id=text(p.id,'id'),custom=s.providers??[];
      if(!custom.some(value=>value.id===id))throw new BadRequestException('只有自定义供应商或已改写的内置供应商可以删除');
      const services=s.services.filter(value=>(value.providerId??'openai-compatible')===id);
      if(services.length)throw new ConflictException(`仍有 ${services.length} 个模型服务关联该供应商，请先停用或迁移这些服务`);
      const credentials=(s.upstreamCredentials??[]).filter(value=>value.providerId===id);
      if(credentials.length)throw new ConflictException(`仍有 ${credentials.length} 个上游凭据属于该供应商，请先停用或改归属`);
      s.providers=custom.filter(value=>value.id!==id);
      return {id,restored:modelProviders(s.providers).some(value=>value.id===id)};
    }
    case 'save.definition':{
      const existing=p.id?pick(s.definitions,p.id,'model definition'):null;
      const modelId=text(p.modelId,'modelId',120);if(s.definitions.some(d=>d.modelId===modelId&&d.id!==existing?.id))throw new ConflictException('model identifier already exists');
      const contextTokens=Number(p.contextTokens);if(!Number.isSafeInteger(contextTokens)||contextTokens<=0)throw new BadRequestException('contextTokens must be a positive integer');
      const estimatedOutputTokens=p.estimatedOutputTokens===undefined?existing?.estimatedOutputTokens:p.estimatedOutputTokens===null||p.estimatedOutputTokens===''?undefined:Number(p.estimatedOutputTokens);
      if(estimatedOutputTokens!==undefined&&(!Number.isSafeInteger(estimatedOutputTokens)||estimatedOutputTokens<1||estimatedOutputTokens>contextTokens))throw new BadRequestException('estimatedOutputTokens must be a positive integer within contextTokens');
      const vendor=p.vendor===undefined?existing?.vendor:p.vendor===null||p.vendor===''?undefined:text(p.vendor,'vendor',100);
      const capabilities=p.capabilities===undefined?existing?.capabilities:strings(p.capabilities,'capabilities');
      if(capabilities?.some(value=>!Object.prototype.hasOwnProperty.call(MODEL_CAPABILITIES,value)))throw new BadRequestException('invalid capabilities');
      const rawMaxOutput=p.maxOutputTokens===undefined?existing?.maxOutputTokens:p.maxOutputTokens;
      const maxOutputTokens=rawMaxOutput===null||rawMaxOutput===''?undefined:rawMaxOutput;
      if(maxOutputTokens!==undefined&&(!Number.isSafeInteger(maxOutputTokens)||Number(maxOutputTokens)<1||Number(maxOutputTokens)>contextTokens))throw new BadRequestException('maxOutputTokens must be a positive integer within contextTokens');
      const billingMultiplier=modelMultiplier(p.billingMultiplier===undefined?existing?.billingMultiplier??1:p.billingMultiplier);
      const kind=modelKind(p.kind??existing?.kind??'chat');
      if(existing&&(existing.kind??'chat')!==kind)for(const service of s.services.filter(v=>v.mappings.some(m=>m.definitionId===existing.id))){for(const mapping of service.mappings.filter(m=>m.definitionId===existing.id)){mapping.meter=undefined;mapping.inputPrice=null;mapping.outputPrice=null;mapping.cachedInputPrice=null;mapping.costPrice=null;}service.configVersion++;service.verification='unverified';service.protocolCapabilities=undefined;service.verificationMessage='模型类型已变更，需要重新配置价格并验证';}
      const definition={kind,billingMultiplier,id:existing?.id??newId('model'),name:text(p.name,'name',100),modelId,contextTokens,estimatedOutputTokens,description:String(p.description??''),active:p.active!==false,vendor,capabilities:capabilities as ModelCapability[]|undefined,maxOutputTokens:maxOutputTokens as number|undefined};
      if(existing)Object.assign(existing,definition);else s.definitions.push(definition);return definition;
    }
    case 'pricing.update':{
      if(p.definitionId){
        const definition=pick(s.definitions,p.definitionId,'definition');
        definition.billingMultiplier=modelMultiplier(p.billingMultiplier);
        return definition;
      }
      const service=pick(s.services,p.serviceId,'service');
      if(!Array.isArray(p.mappings)||!p.mappings.length)throw new BadRequestException('pricing mappings required');
      const changed=new Set<string>();
      for(const raw of p.mappings){
        if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('invalid pricing mapping');
        const mapping=pick(service.mappings.map(item=>({...item,id:item.definitionId})),raw.definitionId,'mapping');
        if(changed.has(mapping.definitionId))throw new BadRequestException('duplicate pricing mapping');
        changed.add(mapping.definitionId);
        const definition=pick(s.definitions,mapping.definitionId,'definition');
        Object.assign(service.mappings.find(item=>item.definitionId===mapping.definitionId)!,mappingPrices(raw,mapping,definition.kind??'chat'));
      }
      return service;
    }
    case 'save.service':{
      const existing=p.id?pick(s.services,p.id,'model service'):null;
      let url:URL;try{url=new URL(text(p.baseUrl,'baseUrl',1000));}catch{throw new BadRequestException('invalid service URL');}
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new BadRequestException('service URL must be HTTP(S) without embedded credentials, query or fragment');
      const providerId=String(p.providerId??existing?.providerId??'openai-compatible'),provider=modelProviders(s.providers).find(v=>v.id===providerId);if(!provider)throw new BadRequestException('provider not found');
      const rawCancellation=p.videoCancellation===undefined?existing?.videoCancellation:p.videoCancellation;
      let videoCancellation:ModelService['videoCancellation'];
      if(rawCancellation){
        const raw=rawCancellation as Record<string,unknown>;
        if(!['POST','DELETE'].includes(String(raw.method))||typeof raw.path!=='string'||!raw.path.includes('{id}')||!/^\/(?!\/)[A-Za-z0-9_./{}~-]+$/.test(raw.path)||raw.path.includes('..'))throw new BadRequestException('invalid controlled video cancellation operation');
        videoCancellation={path:raw.path,method:raw.method as 'POST'|'DELETE'};
      }
      const paths=modalityPaths(p.modalityPaths===undefined?existing?.modalityPaths:p.modalityPaths);
      const credentialRef=p.credentialRef?text(p.credentialRef,'credentialRef',120):null;
      const serviceId=existing?.id??newId('service');
      const rawSecret=typeof p.credentialSecret==='string'?p.credentialSecret.trim():'';
      if(rawSecret&&/[\r\n\u0000]/.test(rawSecret))throw new BadRequestException('invalid provider secret');
      let credentialId=p.credentialId===undefined?existing?.credentialId:p.credentialId?String(p.credentialId):null;
      if(rawSecret){
        /* “自定义密钥” is stored as a service-scoped credential: encrypted, rotated and frozen like a managed one, but never listed or reusable. */
        const scoped=(s.upstreamCredentials??[]).find(value=>value.serviceId===serviceId);
        credentialId=saveUpstreamCredential(s,{...(scoped?{id:scoped.id}:{}),name:scoped?.name??`${text(p.name,'name',100)} · 服务内密钥`,providerId,secret:rawSecret,active:true,serviceId}).id;
      }
      if(credentialId&&credentialRef)throw new BadRequestException('choose managed credential or environment reference');
      if(credentialId){const credential=pick(s.upstreamCredentials??[],credentialId,'upstream credential');if(credential.providerId!==providerId)throw new BadRequestException('credential belongs to another provider');if(credential.serviceId&&credential.serviceId!==serviceId)throw new BadRequestException('credential belongs to another service');frozenServiceCredential(s,credentialId);}
      if(credentialRef&&!/^UPSTREAM_[A-Z0-9_]+$/.test(credentialRef))throw new BadRequestException('credential reference must name a controlled UPSTREAM_ environment variable');
      if(!Array.isArray(p.mappings)||!p.mappings.length)throw new BadRequestException('at least one model mapping required');
      const mappings=p.mappings.map(value=>{
        if(!value||typeof value!=='object'||Array.isArray(value))throw new BadRequestException('invalid model mapping');
        const m=value as Record<string,unknown>,definition=pick(s.definitions,m.definitionId,'definition');
        if(!provider.kinds.includes(definition.kind??'chat'))throw new BadRequestException('provider does not support this model kind');
        const prices=mappingPrices(m,existing?.mappings.find(item=>item.definitionId===definition.id),definition.kind??'chat');
        return {...prices,definitionId:definition.id,upstreamModel:text(m.upstreamModel,'upstreamModel',120),limits:limits(m.limits)};
      });
      if(new Set(mappings.map(m=>m.definitionId)).size!==mappings.length)throw new BadRequestException('duplicate model mapping');
      const baseUrl=url.toString().replace(/\/$/,'');
      const protocolPaths:NonNullable<ModelService['protocolPaths']>={};
      const suppliedPaths=p.protocolPaths===undefined?existing?.protocolPaths??{}:p.protocolPaths;
      if(!suppliedPaths||typeof suppliedPaths!=='object'||Array.isArray(suppliedPaths)||Object.keys(suppliedPaths).some(k=>!['responses','messages'].includes(k)))throw new BadRequestException('invalid protocol paths');
      for(const protocol of ['responses','messages']as const){const path=(suppliedPaths as Record<string,unknown>)[protocol];if(path!==undefined&&path!==''){if(typeof path!=='string'||path.length>500||!/^\/(?!\/)[A-Za-z0-9_./~-]+$/.test(path)||path.includes('..'))throw new BadRequestException('protocol paths must be relative absolute paths on the same service');protocolPaths[protocol]=path;}}
      const connectionShape=(items:ModelService['mappings'])=>items.map(m=>[m.definitionId,m.upstreamModel]).sort((a,b)=>a[0].localeCompare(b[0]));
      const changed=!existing||(existing.providerId??'openai-compatible')!==providerId||!!rawSecret||JSON.stringify(existing.modalityPaths??{})!==JSON.stringify(paths??{})||JSON.stringify(existing.videoCancellation??null)!==JSON.stringify(videoCancellation??null)||existing.baseUrl!==baseUrl||existing.credentialRef!==credentialRef||existing.credentialId!==credentialId||JSON.stringify(existing.protocolPaths??{})!==JSON.stringify(protocolPaths)||JSON.stringify(connectionShape(existing.mappings))!==JSON.stringify(connectionShape(mappings));
      const service:ModelService={videoCancellation,credentialId,providerId,modalityPaths:paths,id:serviceId,name:text(p.name,'name',100),baseUrl,credentialRef,mappings,active:p.active!==false,protocolPaths,protocolCapabilities:changed?undefined:existing?.protocolCapabilities,
        verification:changed?'unverified':existing!.verification,verificationMessage:changed?'连接配置已变更，需要重新验证':existing!.verificationMessage,verifiedAt:changed?null:existing!.verifiedAt,configVersion:(existing?.configVersion??0)+(changed?1:0),limits:limits(p.limits),sharedCapacityId:p.sharedCapacityId?String(p.sharedCapacityId):null};
      if(existing)Object.assign(existing,service);else s.services.push(service);return service;
    }
    case 'save.pool':{
      const existing=p.id?pick(s.pools,p.id,'pool'):null;
      if(!Array.isArray(p.entries))throw new BadRequestException('pool entries required');
      const entries=p.entries.map(value=>{
        if(!value||typeof value!=='object'||Array.isArray(value))throw new BadRequestException('invalid pool entry');
        const e=value as Record<string,unknown>,definition=pick(s.definitions,e.definitionId,'definition'),service=pick(s.services,e.serviceId,'service');
        if(!service.mappings.some(m=>m.definitionId===definition.id))throw new BadRequestException('service does not map this model');
        if(e.open===true&&(!definition.active||!service.active||service.verification!=='passed'))throw new ConflictException('only active verified model sources can be opened');
        const weight=Number(e.weight??1),priority=Number(e.priority??0);if(!Number.isInteger(weight)||weight<1||weight>1000||!Number.isInteger(priority)||priority<0||priority>100)throw new BadRequestException('invalid routing weight or priority');
        return {definitionId:definition.id,serviceId:service.id,open:e.open===true,...(e.weight!==undefined?{weight}:{}),...(e.priority!==undefined?{priority}:{})};
      });
      if(new Set(entries.map(e=>`${e.serviceId}:${e.definitionId}`)).size!==entries.length)throw new BadRequestException('duplicate service model entry in a pool');
      for(const serviceId of new Set(entries.map(e=>e.serviceId))){
        const owner=s.pools.find(pool=>pool.id!==existing?.id&&pool.entries.some(e=>e.serviceId===serviceId));
        if(owner)throw new ConflictException(`模型服务“${s.services.find(service=>service.id===serviceId)?.name??serviceId}”已归属模型池“${owner.name}”，请先从原池移除。`);
      }
      const pool={routing:poolRouting(p.routing===undefined?existing?.routing:p.routing),id:existing?.id??newId('pool'),name:text(p.name,'name',100),entries,limits:limits(p.limits)};
      if(existing)Object.assign(existing,pool);else s.pools.push(pool);return pool;
    }
    case 'save.plan':{
      const existing=p.id?pick(s.plans,p.id,'plan'):null;
      const quotaDays=Number(p.quotaDays??30),entitlementDays=Number(p.entitlementDays??365);
      if(![quotaDays,entitlementDays].every(v=>Number.isInteger(v)&&v>=1&&v<=3650))throw new BadRequestException('validity days must be between 1 and 3650');
      if(p.cadence!=='once'&&p.cadence!=='monthly')throw new BadRequestException('invalid cadence');
      const plan:Plan={id:existing?.id??newId('plan'),name:text(p.name,'name',100),version:(existing?.version??0)+1,range:range(s,p.range),amount:amount(p.amount),cadence:p.cadence,quotaDays,entitlementDays,active:p.active!==false,limits:limits(p.limits)};
      if(existing)Object.assign(existing,plan);else s.plans.push(plan);return plan;
    }
    case 'save.rule':{
      const rule=ruleCandidate(s,p),existing=s.rules.find(r=>r.id===rule.id);
      if(existing)Object.assign(existing,rule);else s.rules.push(rule);return rule;
    }
    case 'save.project':{
      const existing=p.id?manager(s,actor,p.id):null;
      if(existing?.status==='ended')throw new ConflictException('ended projects are immutable');
      if(p.status==='ended'){if(!existing)throw new BadRequestException('create a project before ending it');return endProject(tx,actor,existing.id,p.reason);}
      if(!existing)operator(actor);else if(!actor.roles.includes('operator')&&(p.range||p.managerId&&p.managerId!==existing.managerId))throw new ForbiddenException('only operators may change manager or project model scope');
      const before=existing?structuredClone(existing):null;
      const projectManager=activeMember(s,text(p.managerId??existing?.managerId,'managerId'));
      const project={id:existing?.id??newId('project'),name:text(p.name,'name',100),description:String(p.description??''),managerId:projectManager.id,applicantId:existing?.applicantId??actor.id,
        memberIds:[...new Set([...(existing?.memberIds??[]),projectManager.id])],status:(p.status??existing?.status??'active') as 'active'|'paused'|'ended',range:existing&&!p.range?existing.range:range(s,p.range),limits:limits(p.limits)};
      if(!['active','paused','ended'].includes(project.status))throw new BadRequestException('invalid project status');
      if(existing)Object.assign(existing,project);else {const value=amount(p.initialAmount),expiresAt=quotaExpiry(p),budget={id:newId('project-budget'),projectId:project.id,totalAmount:value,availableAmount:value,expiresAt,createdAt:now()};s.projects.push(project);await tx.fundBudget(budget);s.audit.push({id:newId('audit'),actorId:actor.id,action:'project.initial_grant',objectId:project.id,reason:'创建时发放初始预算',createdAt:now(),detail:budget});}
      if(before)s.audit.push({id:newId('audit'),actorId:actor.id,action:'project.changed',objectId:project.id,reason:String(p.reason??'项目配置变更'),createdAt:now(),detail:{before,after:structuredClone(project)}});return project;
    }
    case 'save.application':{
      const existing=p.id?owner(s,actor,p.id):null;if(!existing)operator(actor);
      const billingMode=(p.billingMode??(existing?applicationBillingMode(existing):'accounting')) as ApplicationBillingMode;
      if(!['accounting','quota'].includes(billingMode))throw new BadRequestException('invalid application billing mode');
      if(existing&&billingMode!==applicationBillingMode(existing))throw new ConflictException('application billing mode changes require approval');
      if(existing&&!actor.roles.includes('operator')&&(p.range||p.ownerId&&p.ownerId!==existing.ownerId))throw new ForbiddenException('operator required to change application range or owner');
      const before=existing?structuredClone(existing):null;
      const appOwner=activeMember(s,text(p.ownerId??existing?.ownerId,'ownerId')),organization=pick(s.organizations,p.organizationId??existing?.organizationId,'organization');
      const completionChannelId=p.completionChannelId===undefined?existing?.completionChannelId??null:p.completionChannelId?String(p.completionChannelId):null;
      if(completionChannelId)pick(s.monitoring?.channels??[],completionChannelId,'completion notification channel');
      const app={completionChannelId,id:existing?.id??newId('application'),billingMode,name:text(p.name,'name',100),description:String(p.description??''),ownerId:appOwner.id,organizationId:organization.id,active:p.active!==false,range:existing&&!p.range?existing.range:range(s,p.range),limits:limits(p.limits)};
      if(!existing&&billingMode==='accounting')await tx.grant({id:newId('accounting'),accounting:true,sourceType:'application_wallet',sourceId:app.id,organizationId:s.tenantId,projectId:null,purpose:'application',totalAmount:0,availableAmount:0,modelIds:availableModels(s,app.range),expiresAt:'9999-12-31T23:59:59.999Z',entitlementId:null,sourceBatchId:null});
      if(!existing&&billingMode==='quota'){const value=amount(p.initialAmount),batch={id:newId('quota'),sourceType:'application_wallet' as const,sourceId:app.id,organizationId:s.tenantId,projectId:null,purpose:'application' as const,totalAmount:value,availableAmount:value,modelIds:availableModels(s,app.range),expiresAt:quotaExpiry(p),entitlementId:null,sourceBatchId:null};await tx.grant(batch);s.audit.push({id:newId('audit'),actorId:actor.id,action:'application.initial_grant',objectId:app.id,reason:'创建时发放初始额度',createdAt:now(),detail:batch});}
      if(existing&&existing.ownerId!==appOwner.id){if(p.handoffKeys!==undefined&&!['preserve','revoke'].includes(String(p.handoffKeys)))throw new BadRequestException('invalid key handoff policy');if(p.handoffKeys==='revoke')for(const key of s.keys)if(key.subjectId===app.id)key.status='revoked';}
      if(before)s.audit.push({id:newId('audit'),actorId:actor.id,action:'application.changed',objectId:app.id,reason:String(p.reason??'应用配置或负责人变更'),createdAt:now(),detail:{before,after:structuredClone(app),handoffKeys:p.handoffKeys??'preserve',keyIds:s.keys.filter(k=>k.subjectId===app.id).map(k=>k.id)}});
      if(existing)Object.assign(existing,app);else s.applications.push(app);s.keys.filter(k=>k.subjectId===app.id).forEach(k=>k.ownerId=appOwner.id);return app;
    }
    default:throw new BadRequestException('unknown resource command');
  }
}

export function memberImportRows(s:WorkspaceState,input:unknown):Record<string,unknown>[]{
  if(!Array.isArray(input)||!input.length||input.length>1000)throw new BadRequestException('rows must contain between 1 and 1000 members');
  const seen=new Set<string>();return input.map((row,index)=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw new BadRequestException(`invalid member row ${index+1}`);
    const record=row as Record<string,unknown>,directoryId=text(record.directoryId,'directoryId',100);
    if(seen.has(directoryId))throw new BadRequestException(`duplicate directoryId at row ${index+1}`);seen.add(directoryId);
    if(['password','passwordHash','roles','id'].some(key=>key in record))throw new BadRequestException('import cannot change passwords or roles; use the member editor');
    const existing=s.members.find(m=>m.directoryId===directoryId);
    const allowed=['name','organizationId','category','tags','active','validUntil','sponsorId'];
    return {...(existing?publicMember(existing):{}),...Object.fromEntries(allowed.filter(key=>key in record).map(key=>[key,record[key]])),directoryId,id:existing?.id};
  });
}
export function ruleCandidate(s:WorkspaceState,p:Record<string,unknown>):AutoRule{
  const existing=p.id?pick(s.rules,p.id,'rule'):null,plan=pick(s.plans,p.planId,'plan');
  if(p.organizationId)pick(s.organizations,p.organizationId,'organization');
  if(p.category&&!['employee','contractor'].includes(String(p.category)))throw new BadRequestException('invalid category');
  return {id:existing?.id??newId('rule'),name:text(p.name,'name',100),planId:plan.id,organizationId:p.organizationId?String(p.organizationId):null,includeChildren:p.includeChildren===true,category:(p.category??null) as AutoRule['category'],tags:strings(p.tags??[],'tags'),active:p.active!==false};
}
