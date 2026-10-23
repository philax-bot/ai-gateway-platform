import { describe,it,expect } from 'vitest';
import { parseMemberImport } from './member-import.js';
import type { PlatformSnapshot } from './platform.js';
const context={organizations:[{id:'org',name:'研发部'}],members:[{id:'sponsor',directoryId:'leader'}]} as Pick<PlatformSnapshot,'organizations'|'members'>;
describe('member CSV/TSV import integrity',()=>{
  it('preserves quoted delimiters, escaped quotes, unicode and explicit empty cells',()=>{
    const [row]=parseMemberImport('\uFEFF登录标识,姓名,组织,业务标签,状态,有效日期\r\nuser,"张,\n""三""",org,"AI;研发",停用,2028-02-29',context);
    expect(row).toMatchObject({directoryId:'user',name:'张,\n"三"',organizationId:'org',tags:['AI','研发'],active:false,validUntil:'2028-02-29T23:59:59.999+08:00'});
    expect(parseMemberImport('directoryId\tname\torganizationId\tvalidUntil\tsponsorId\nu\t姓名\t研发部\t\tleader',context)[0]).toEqual({directoryId:'u',name:'姓名',organizationId:'org',validUntil:null,sponsorId:'sponsor'});
    expect(parseMemberImport('登录账号,姓名,组织,责任人登录账号\nu,姓名,org,leader',context)[0]).toMatchObject({directoryId:'u',name:'姓名',organizationId:'org',sponsorId:'sponsor'});
  });
  it('rejects identity ambiguity and malformed input instead of silently shifting cells',()=>{
    for(const source of [
      'directoryId,name,organizationId\nu,姓名,org\nu,重复,org',
      'directoryId,name,organizationId\nu,姓名,org,多列',
      'directoryId,name,organizationId\nu,"姓名,org',
      'directoryId,name,organizationId\nu,"姓名"bad,org',
      'directoryId,name,organizationId,roles\nu,姓名,org,operator',
      'directoryId,name,organizationId,__proto__\nu,姓名,org,x',
      'directoryId,name,organizationId,active\nu,姓名,org,__proto__',
      'directoryId,name,organizationId,validUntil\nu,姓名,org,2027-02-29',
      'directoryId,登录标识,name,organizationId\nu,u,姓名,org',
      'directoryId,登录账号,name,organizationId\nu,u,姓名,org',
    ])expect(()=>parseMemberImport(source,context)).toThrow();
    expect(()=>parseMemberImport('directoryId,name,organizationId\nu,姓名,研发部',{...context,organizations:[...context.organizations,{...context.organizations[0],id:'org2'}]})).toThrow('同名');
  });
});
