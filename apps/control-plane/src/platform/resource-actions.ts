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
  const roles=strings(p.roles??existing?.roles??['employee'],'roles');if(roles.some(role=>!['employee','operator'].includes(role)))throw new BadRequestException('invalid role');
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
  if(type!=='save.project'&&type!=='save.application')operator(actor);
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
    case 'save.definition':{
      const existing=p.id?pick(s.definitions,p.id,'model definition'):null;
      const modelId=text(p.modelId,'modelId',120);if(s.definitions.some(d=>d.modelId===modelId&&d.id!==existing?.id))throw new ConflictException('model identifier already exists');
      const contextTokens=Number(p.contextTokens);if(!Number.isSafeInteger(contextTokens)||contextTokens<=0)throw new BadRequestException('contextTokens must be a positive integer');
      const vendor=p.vendor===undefined?existing?.vendor:p.vendor===null||p.vendor===''?undefined:text(p.vendor,'vendor',100);
      const capabilities=p.capabilities===undefined?existing?.capabilities:strings(p.capabilities,'capabilities');
      if(capabilities?.some(value=>!Object.prototype.hasOwnProperty.call(MODEL_CAPABILITIES,value)))throw new BadRequestException('invalid capabilities');
      const rawMaxOutput=p.maxOutputTokens===undefined?existing?.maxOutputTokens:p.maxOutputTokens;
      const maxOutputTokens=rawMaxOutput===null||rawMaxOutput===''?undefined:rawMaxOutput;
      if(maxOutputTokens!==undefined&&(!Number.isSafeInteger(maxOutputTokens)||Number(maxOutputTokens)<1||Number(maxOutputTokens)>contextTokens))throw new BadRequestException('maxOutputTokens must be a positive integer within contextTokens');
      const definition={id:existing?.id??newId('model'),name:text(p.name,'name',100),modelId,contextTokens,description:String(p.description??''),active:p.active!==false,vendor,capabilities:capabilities as ModelCapability[]|undefined,maxOutputTokens:maxOutputTokens as number|undefined};
      if(existing)Object.assign(existing,definition);else s.definitions.push(definition);return definition;
    }
    case 'save.service':{
      const existing=p.id?pick(s.services,p.id,'model service'):null;
      let url:URL;try{url=new URL(text(p.baseUrl,'baseUrl',1000));}catch{throw new BadRequestException('invalid service URL');}
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new BadRequestException('service URL must be HTTP(S) without embedded credentials, query or fragment');
      const credentialRef=p.credentialRef?text(p.credentialRef,'credentialRef',120):null;
      if(credentialRef&&!/^UPSTREAM_[A-Z0-9_]+$/.test(credentialRef))throw new BadRequestException('credential reference must name a controlled UPSTREAM_ environment variable');
      if(!Array.isArray(p.mappings)||!p.mappings.length)throw new BadRequestException('at least one model mapping required');
      const mappings=p.mappings.map(value=>{
        if(!value||typeof value!=='object'||Array.isArray(value))throw new BadRequestException('invalid model mapping');
        const m=value as Record<string,unknown>,definition=pick(s.definitions,m.definitionId,'definition');
        const price=(v:unknown):number|null=>{if(v===null||v===undefined)return null;if(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e9&&Math.abs(v*1e6-Math.round(v*1e6))<=0.001)return v;throw new BadRequestException('price must be nonnegative with at most six decimals, or explicitly unknown');};
        return {definitionId:definition.id,upstreamModel:text(m.upstreamModel,'upstreamModel',120),inputPrice:price(m.inputPrice),outputPrice:price(m.outputPrice),cachedInputPrice:price(m.cachedInputPrice),limits:limits(m.limits)};
      });
      if(new Set(mappings.map(m=>m.definitionId)).size!==mappings.length)throw new BadRequestException('duplicate model mapping');
      const baseUrl=url.toString().replace(/\/$/,'');
      const protocolPaths:NonNullable<ModelService['protocolPaths']>={};
      const suppliedPaths=p.protocolPaths===undefined?existing?.protocolPaths??{}:p.protocolPaths;
      if(!suppliedPaths||typeof suppliedPaths!=='object'||Array.isArray(suppliedPaths)||Object.keys(suppliedPaths).some(k=>!['responses','messages'].includes(k)))throw new BadRequestException('invalid protocol paths');
      for(const protocol of ['responses','messages']as const){const path=(suppliedPaths as Record<string,unknown>)[protocol];if(path!==undefined&&path!==''){if(typeof path!=='string'||path.length>500||!/^\/(?!\/)[A-Za-z0-9_./~-]+$/.test(path)||path.includes('..'))throw new BadRequestException('protocol paths must be relative absolute paths on the same service');protocolPaths[protocol]=path;}}
      const connectionShape=(items:ModelService['mappings'])=>items.map(m=>[m.definitionId,m.upstreamModel]).sort((a,b)=>a[0].localeCompare(b[0]));
      const changed=!existing||existing.baseUrl!==baseUrl||existing.credentialRef!==credentialRef||JSON.stringify(existing.protocolPaths??{})!==JSON.stringify(protocolPaths)||JSON.stringify(connectionShape(existing.mappings))!==JSON.stringify(connectionShape(mappings));
      const service:ModelService={id:existing?.id??newId('service'),name:text(p.name,'name',100),baseUrl,credentialRef,mappings,active:p.active!==false,protocolPaths,protocolCapabilities:changed?undefined:existing?.protocolCapabilities,
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
        return {definitionId:definition.id,serviceId:service.id,open:e.open===true};
      });
      if(new Set(entries.map(e=>`${e.serviceId}:${e.definitionId}`)).size!==entries.length)throw new BadRequestException('duplicate service model entry in a pool');
      for(const serviceId of new Set(entries.map(e=>e.serviceId))){
        const owner=s.pools.find(pool=>pool.id!==existing?.id&&pool.entries.some(e=>e.serviceId===serviceId));
        if(owner)throw new ConflictException(`模型服务“${s.services.find(service=>service.id===serviceId)?.name??serviceId}”已归属模型池“${owner.name}”，请先从原池移除。`);
      }
      const pool={id:existing?.id??newId('pool'),name:text(p.name,'name',100),entries,limits:limits(p.limits)};
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
      const projectManager=activeMember(s,text(p.managerId??existing?.managerId,'managerId'));
      const project={id:existing?.id??newId('project'),name:text(p.name,'name',100),description:String(p.description??''),managerId:projectManager.id,applicantId:existing?.applicantId??actor.id,
        memberIds:[...new Set([...(existing?.memberIds??[]),projectManager.id])],status:(p.status??existing?.status??'active') as 'active'|'paused'|'ended',range:existing&&!p.range?existing.range:range(s,p.range),limits:limits(p.limits)};
      if(!['active','paused','ended'].includes(project.status))throw new BadRequestException('invalid project status');
      if(existing)Object.assign(existing,project);else s.projects.push(project);return project;
    }
    case 'save.application':{
      const existing=p.id?owner(s,actor,p.id):null;if(!existing)operator(actor);
      const billingMode=(p.billingMode??(existing?applicationBillingMode(existing):'accounting')) as ApplicationBillingMode;
      if(!['accounting','quota'].includes(billingMode))throw new BadRequestException('invalid application billing mode');
      if(existing&&billingMode!==applicationBillingMode(existing))throw new ConflictException('application billing mode changes require approval');
      if(existing&&!actor.roles.includes('operator')&&(p.range||p.ownerId&&p.ownerId!==existing.ownerId))throw new ForbiddenException('operator required to change application range or owner');
      const appOwner=activeMember(s,text(p.ownerId??existing?.ownerId,'ownerId')),organization=pick(s.organizations,p.organizationId??existing?.organizationId,'organization');
      const app={id:existing?.id??newId('application'),billingMode,name:text(p.name,'name',100),description:String(p.description??''),ownerId:appOwner.id,organizationId:organization.id,active:p.active!==false,range:existing&&!p.range?existing.range:range(s,p.range),limits:limits(p.limits)};
      if(!existing&&billingMode==='accounting')await tx.grant({id:newId('accounting'),accounting:true,sourceType:'application_wallet',sourceId:app.id,organizationId:s.tenantId,projectId:null,purpose:'application',totalAmount:0,availableAmount:0,modelIds:availableModels(s,app.range),expiresAt:'9999-12-31T23:59:59.999Z',entitlementId:null,sourceBatchId:null});
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
