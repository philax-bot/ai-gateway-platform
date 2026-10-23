import type { OrganizationChangeImpact } from '@ai-gateway/contracts';
import { Table } from './components';

export function OrganizationImpact({change}:{change:OrganizationChangeImpact}){
  const blocked=change.members.filter(m=>m.beforeAccess&&!m.afterAccess),restored=change.members.filter(m=>!m.beforeAccess&&m.afterAccess);
  return <><h3>{change.name} · 调整影响</h3><dl className="detail-list"><div><dt>上级组织</dt><dd>{change.beforeActive===null?'新建':change.beforeParent??'无（企业根组织）'} → {change.afterParent??'无（企业根组织）'}</dd></div><div><dt>组织状态</dt><dd>{change.beforeActive===null?'新建':change.beforeActive?'启用':'停用'} → {change.afterActive?'启用':'停用'}</dd></div></dl>
    <p>范围包含本组织及全部下级：{change.organizations.length} 个组织、{change.members.length} 名成员，{change.personalKeyCount} 把个人或项目密钥。</p>
    {!!blocked.length&&<p className="notice warning">{blocked.length} 名成员将不能登录或发起新的个人、项目调用。已准入请求继续按原来源结算。</p>}
    {!!restored.length&&<p className="notice">{restored.length} 名成员恢复账号访问，实际调用仍受各自有效权益、余额和密钥状态限制。</p>}
    <p className="secondary">{change.rematches?'保存时重新匹配范围内成员的自动开通规则，新增发放和周期变化见下方。':'本次不改变组织归属或状态，不触发自动开通。'}成员归属、下级组织自身的启用状态、已发资金批次和到期日保留。</p>
    {!!change.members.length&&<details className="disclosure"><summary>查看受影响人员及访问变化</summary><Table headers={['成员','主要组织','当前访问','保存后访问']} rows={change.members.map(m=>[m.name,m.organizationName,m.beforeAccess?'可访问':'已受限',m.afterAccess?'可访问':'受限（组织、成员状态或有效期）'])}/></details>}
    {(!!change.projects.length||!!change.applications.length)&&<details className="disclosure" open={!!blocked.length||undefined}><summary>项目经理与应用负责人</summary><Table headers={['类型','业务对象','负责人']} rows={[...change.projects.map(p=>['项目',p.name,p.managerName]),...change.applications.map(a=>['应用',a.name,a.ownerName])]}/><p className="secondary">业务对象保留。负责人失去访问后由运营交接；应用独立运行，应用密钥仍按应用自身状态和有效期核对，不因负责人所在组织停用而自动吊销。</p></details>}
  </>;
}
