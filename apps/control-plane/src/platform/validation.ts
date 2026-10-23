import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Member, ModelRange, UsageLimits, WorkspaceState } from '@ai-gateway/contracts';

export const now = () => new Date().toISOString();
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function text(value: unknown, name: string, max=500): string {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new BadRequestException(`${name} is required (max ${max})`);
  return value.trim();
}
export function strings(value: unknown, name: string): string[] {
  if(!Array.isArray(value)||value.length>1000||value.some(v=>typeof v!=='string'||!v.trim()))throw new BadRequestException(`${name} must be a string list`);
  return [...new Set(value as string[])];
}
export function amount(value: unknown): number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1_000_000_000||Math.abs(value*1e6-Math.round(value*1e6))>0.001)throw new BadRequestException('amount must be positive with at most six decimals');
  return value;
}
export function expiry(value: unknown): string {
  const date=typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;
  if(!Number.isFinite(date)||date<=Date.now())throw new BadRequestException('a future expiry timestamp is required');
  return new Date(date).toISOString();
}
export function pick<T extends {id:string}>(items:T[], id:unknown, label:string):T {
  const item=items.find(i=>i.id===id);if(!item)throw new NotFoundException(`${label} not found`);return item;
}
export function activeMember(state: WorkspaceState,id:string): Member {
  const member=pick(state.members,id,'member');
  if(!member.active||(member.validUntil&&Date.parse(member.validUntil)<=Date.now()))throw new ForbiddenException('member is disabled or expired');
  let organization=pick(state.organizations,member.organizationId,'organization');
  const visited=new Set<string>();
  while(organization) {
    if(!organization.active||visited.has(organization.id))throw new ForbiddenException('organization is disabled or invalid');
    visited.add(organization.id);if(!organization.parentId)break;
    organization=pick(state.organizations,organization.parentId,'organization');
  }
  return member;
}
export function operator(member:Member):void {if(!member.roles.includes('operator'))throw new ForbiddenException('operator role required');}
export function limits(value:unknown):UsageLimits {
  const v=value as UsageLimits|undefined;if(!v)return {mode:'inherit'};
  if(!['inherit','none','custom'].includes(v.mode))throw new BadRequestException('invalid limit mode');
  for(const n of [v.rpm,v.tpm,v.concurrency,v.maxOutputTokens])if(n!==undefined&&(!Number.isSafeInteger(n)||n<=0))throw new BadRequestException('limits must be positive integers');
  return {mode:v.mode,rpm:v.rpm,tpm:v.tpm,concurrency:v.concurrency,maxOutputTokens:v.maxOutputTokens};
}
export function range(state:WorkspaceState,value:unknown):ModelRange {
  const r=value as ModelRange;if(!r||!['follow','specific'].includes(r.mode))throw new BadRequestException('model range is required');
  const pool=pick(state.pools,r.poolId,'model pool');
  const ids=r.mode==='specific'?strings(r.definitionIds,'definitionIds'):[];
  if(r.mode==='specific'&&(!ids.length||ids.some(id=>!pool.entries.some(e=>e.definitionId===id))))throw new BadRequestException('specific range must select models in this pool');
  return {poolId:pool.id,mode:r.mode,definitionIds:ids};
}
export function availableModels(state:WorkspaceState,r:ModelRange):string[] {
  const pool=state.pools.find(p=>p.id===r.poolId);if(!pool)return [];
  return pool.entries.filter(e=>e.open&&(r.mode==='follow'||r.definitionIds.includes(e.definitionId)))
    .filter(e=>state.services.some(s=>s.id===e.serviceId&&s.active&&s.verification==='passed'&&s.mappings.some(m=>m.definitionId===e.definitionId)))
    .flatMap(e=>state.definitions.filter(d=>d.id===e.definitionId&&d.active).map(d=>d.modelId));
}
export function passwordHash(password:string):string {
  if(password.length<12||password.length>256)throw new BadRequestException('password must contain 12 to 256 characters');
  const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
export function verifyPassword(password:string,stored:string):boolean {
  const [salt,key]=stored.split(':');if(!salt||!key)return false;
  const expected=Buffer.from(key,'hex');const actual=scryptSync(password,salt,64);
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
