import {beforeEach,describe,expect,it} from 'vitest';
import {initialWorkspace} from './seed';
import {queryPeople,queryPeopleOrganizations} from './people-query';

const admin='operator-demo-001',employee='employee-demo-001';
describe('scoped paginated person selection',()=>{
  let state:ReturnType<typeof initialWorkspace>;
  beforeEach(()=>{state=initialWorkspace();state.organizations.push({id:'team-a',name:'平台组',parentId:'department-engineering',active:true},{id:'team-b',name:'业务组',parentId:'org-demo',active:true});
    for(let i=0;i<90;i++)state.members.push({...structuredClone(state.members[1]),id:`member-${i}`,name:i<2?'同名员工':`人员 ${i}`,directoryId:`account-${i.toString().padStart(3,'0')}`,organizationId:i%2?'team-a':'team-b',passwordHash:'never-return-this'});
    state.projects.push({id:'project',name:'项目',description:'',managerId:employee,applicantId:admin,memberIds:[employee,'member-0'],status:'active',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]},limits:{mode:'inherit'}});
  });
  it('pages deterministic results and searches login accounts and complete organization paths',()=>{
    const a=queryPeople(state,admin,{scope:'onboarding',page:1,pageSize:25}),b=queryPeople(state,admin,{scope:'onboarding',page:2,pageSize:25});
    expect(a.total).toBe(92);expect(a.items).toHaveLength(25);expect(b.items.every(p=>!a.items.some(x=>x.id===p.id))).toBe(true);
    const same=queryPeople(state,admin,{scope:'onboarding',query:'同名员工'});expect(same.items.map(p=>p.directoryId).sort()).toEqual(['account-000','account-001']);
    expect(queryPeople(state,admin,{scope:'onboarding',query:'account-001'}).items[0].organizationPath).toBe('企业工作空间 / 研发部 / 平台组');
    expect(queryPeople(state,admin,{scope:'onboarding',query:'研发部 / 平台组'}).total).toBe(45);
    expect(JSON.stringify(a)).not.toMatch(/passwordHash|never-return-this|roles|sponsorId/);
  });
  it('distinguishes parent-only organization filtering, descendant filtering and lazy tree reads',()=>{
    expect(queryPeople(state,admin,{scope:'onboarding',organizationId:'department-engineering',includeChildren:false}).total).toBe(1);
    expect(queryPeople(state,admin,{scope:'onboarding',organizationId:'department-engineering',includeChildren:true}).total).toBe(46);
    const root=queryPeopleOrganizations(state,admin,{scope:'onboarding'});expect(root.items.map(o=>o.id)).toEqual(['org-demo']);expect(root.items[0].hasChildren).toBe(true);
    expect(queryPeopleOrganizations(state,admin,{scope:'onboarding',parentId:'department-engineering'}).items.map(o=>o.id)).toEqual(['team-a']);
    expect(queryPeopleOrganizations(state,admin,{scope:'onboarding',query:'平台组'}).items[0].path).toContain('研发部 / 平台组');
  });
  it('restricts general person lookup and organization discovery to existing peer visibility',()=>{
    const rows=queryPeople(state,employee,{scope:'manager'});expect(rows.items.map(p=>p.id).sort()).toEqual([employee,'member-0'].sort());
    expect(queryPeople(state,employee,{scope:'directory',ids:['member-1']}).items).toEqual([]);
    expect(queryPeopleOrganizations(state,employee,{scope:'manager',query:'平台组'}).items).toEqual([]);
    expect(()=>queryPeople(state,employee,{scope:'onboarding'})).toThrow();
  });
  it('requires project management and constrains allocation and membership candidates',()=>{
    expect(queryPeople(state,employee,{scope:'project-members',projectId:'project'}).items.some(p=>p.id==='member-0')).toBe(false);
    expect(queryPeople(state,employee,{scope:'project-members',projectId:'project',ids:['member-0']}).items[0].unavailableReason).toBe('已加入当前项目');
    expect(queryPeople(state,employee,{scope:'project-allocation',projectId:'project'}).items.map(p=>p.id).sort()).toEqual([employee,'member-0'].sort());
    expect(()=>queryPeople(state,'member-1',{scope:'project-members',projectId:'project'})).toThrow('project manager');
    expect(()=>queryPeopleOrganizations(state,'member-1',{scope:'project-members',projectId:'project'})).toThrow();
    state.projects[0].status='ended';expect(()=>queryPeople(state,employee,{scope:'project-members',projectId:'project'})).toThrow('项目当前');
  });
  it('returns disabled reasons for stale selections and internal-only sponsor eligibility',()=>{
    state.members.find(m=>m.id==='member-0')!.active=false;state.members.find(m=>m.id==='member-1')!.validUntil='2020-01-01T00:00:00Z';state.members.find(m=>m.id==='member-2')!.category='contractor';
    const people=queryPeople(state,admin,{scope:'sponsor',ids:['member-0','member-1','member-2'],excludeIds:['member-0']}).items;
    expect(people.every(p=>!p.selectable)).toBe(true);expect(people.map(p=>p.unavailableReason)).toEqual(expect.arrayContaining(['不在本次可选范围','人员已到期','内部责任人必须为员工']));
    state.organizations.find(o=>o.id==='team-a')!.active=false;expect(queryPeople(state,admin,{scope:'onboarding',ids:['member-3']}).items[0].unavailableReason).toContain('组织');
  });
  it('rejects malformed or unbounded queries',()=>{
    for(const patch of [{page:0},{pageSize:1000},{scope:'unknown'},{ids:'all'},{query:'x'.repeat(201)},{category:'other'},{includeChildren:'yes'}])expect(()=>queryPeople(state,admin,{scope:'onboarding',...patch} as any)).toThrow();
    state.organizations.find(o=>o.id==='team-a')!.parentId='team-a';expect(queryPeople(state,admin,{scope:'onboarding',ids:['member-1']}).items[0].selectable).toBe(false);
  });
});
