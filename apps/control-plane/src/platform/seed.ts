import type { WorkspaceState } from '@ai-gateway/contracts';
import {runtimeMode} from '@ai-gateway/contracts';

export function initialWorkspace(): WorkspaceState {
  if(runtimeMode(process.env)==='production')return {
    version:1,tenantId:'org-demo',revision:0,organizations:[{id:'org-demo',name:'企业工作空间',parentId:null,active:true}],members:[],definitions:[],services:[],pools:[],plans:[],entitlements:[],rules:[],projects:[],applications:[],approvals:[],keys:[],distributions:[],notifications:[],audit:[],sessions:[],operations:{},
    settings:{name:'Signal Atlas',timezone:'Asia/Shanghai',personalDefaultPoolId:null,projectDefaultPoolId:null,limits:{mode:'custom',rpm:60,concurrency:5,maxOutputTokens:4096},retentionDays:90},
  };
  return {
    version: 1, tenantId: 'org-demo', revision: 0,
    organizations: [{ id: 'org-demo', name: '企业工作空间', parentId: null, active: true },
      { id: 'department-engineering', name: '研发部', parentId: 'org-demo', active: true }],
    members: [
      { id: 'operator-demo-001', name: '运营管理员', directoryId: 'operator', organizationId: 'org-demo', category: 'employee', tags: [], roles: ['operator','employee'], active: true, validUntil: null, sponsorId: null },
      { id: 'employee-demo-001', name: '演示员工', directoryId: 'employee', organizationId: 'department-engineering', category: 'employee', tags: ['AI 编码'], roles: ['employee'], active: true, validUntil: null, sponsorId: null },
    ],
    definitions: [{ id: 'definition-test-model', name: '本地测试模型', modelId: 'test-model', contextTokens: 32768, description: '仅用于本地业务验收，不执行真实推理', active: true }],
    services: [{ id: 'service-local-test', name: '本地测试服务', baseUrl: 'http://127.0.0.1:4010', credentialRef: null, active: true,
      mappings: [{ definitionId: 'definition-test-model', upstreamModel: 'test-model', inputPrice: 0, outputPrice: 0, cachedInputPrice: 0, limits: { mode: 'inherit' } }],
      verification: 'unverified', verificationMessage: '尚未运行真实连接验证', verifiedAt: null, configVersion: 1, limits: { mode: 'inherit' }, sharedCapacityId: null }],
    pools: [{ id: 'pool-local-test', name: '本地测试模型池', entries: [{ definitionId: 'definition-test-model', serviceId: 'service-local-test', open: false }], limits: { mode: 'inherit' } }],
    plans: [], entitlements: [], rules: [], projects: [], applications: [], approvals: [], keys: [], distributions: [], notifications: [], audit: [], sessions: [], operations: {},
    settings: { name: 'Signal Atlas', timezone: 'Asia/Shanghai', personalDefaultPoolId: 'pool-local-test', projectDefaultPoolId: 'pool-local-test', limits: { mode: 'custom', rpm: 60, concurrency: 5, maxOutputTokens: 4096 }, retentionDays: 90 },
  };
}
