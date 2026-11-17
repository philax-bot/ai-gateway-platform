import type { PlatformCommand, PlatformSnapshot } from '@ai-gateway/contracts';
const base=(import.meta.env.VITE_CONTROL_PLANE_URL??'http://127.0.0.1:4001').replace(/\/+$/,'');
export const controlPlaneBaseUrl=base;
export const gatewayBaseUrl=(import.meta.env.VITE_GATEWAY_URL??'http://127.0.0.1:4000').replace(/\/+$/,'');
export const openAiBaseUrl=`${gatewayBaseUrl}/v1`;
export function gatewayFailureMessage(raw:string):string{
  try{const type=JSON.parse(raw).error?.type;if(type==='video_cancellation_unavailable')return '取消请求尚未发送，当前服务连接暂不可用，请稍后重试。';if(type==='video_cancellation_unknown')return '取消结果尚未确认，请刷新任务状态；任务仍在生成时可重新请求取消。';if(type==='video_cancellation_rejected')return '供应商未接受取消请求，请核对任务状态后重试。';}catch{/* Other gateway errors retain their existing handling. */}
  try{const value=JSON.parse(raw),type=value.error?.type;if(['safety_policy_violation','guardrail_policy_stale','guardrail_unavailable'].includes(type))return (type==='safety_policy_violation'?'输入被企业安全策略拦截，未发送给模型，未扣费。请修改后重试。':type==='guardrail_policy_stale'?'安全策略已更新，请重试。':'安全检查暂不可用，请稍后重试。')+(value.requestId?' 请求编号：'+String(value.requestId):'');}catch{}return raw;
}
export class ApiError extends Error { constructor(message:string,readonly status:number){super(message);} }
export function approvalFailureMessage(message:string):string{
  const messages:Record<string,string>={
    'source budget is expired or insufficient':'项目来源预算已到期或余额不足，请调整来源或批准金额。',
    'plan not found':'批准的方案已不存在，请重新选择开通方案。',
    'plan is disabled':'批准的方案已停用，请选择有效的开通方案。',
    'source budget not found':'项目来源预算已不存在，请重新选择。',
    'member quota must inherit the selected budget expiry':'成员额度必须沿用来源预算的到期时间，请重新核对来源。',
    'active project membership required':'申请人已不在有效项目中，请核对成员关系；不再需要时可关闭申请。',
    'project approval scope changed':'项目状态或经理已变化，请核对当前职责；不再需要时可关闭申请。',
    'application owner or state changed':'应用已停用或负责人已变更，请核对后处理；原申请可关闭。',
    'application owner, state or billing mode changed':'应用负责人、状态或计费模式已变化，请核对后处理；原申请可关闭。',
    'top-up must not outlive its active entitlement':'原个人权益已失效，或批准期限超出权益期限，请核对后处理。',
    'member already has this plan; request a top-up instead':'申请人已有该方案权益，请关闭本单后申请追加额度。',
    'quota cannot outlive the approved model entitlement':'额度到期日超出模型权益期限，请缩短批准期限。',
    'a future expiry timestamp is required':'批准期限已到期，请调整后重试。',
    'member is disabled or expired':'申请人已停用或到期，请核对账号状态；不再需要时可关闭申请。',
  };
  return messages[message]??(/[\u4e00-\u9fff]/.test(message)?message:'执行尚未完成，请核对配置后重试，或关闭不再需要的申请。');
}
function readableError(status:number,message:unknown,path:string):string{
  const value=Array.isArray(message)?message.join('；'):typeof message==='string'?message:'';
  if(value==='amount must be positive with at most six decimals')return '额度必须大于 0，最多六位小数，且不超过 10 亿元。';
  if(value==='a future expiry timestamp is required')return '请选择未来的有效日期；项目或应用额度也可明确选择长期有效。';
  if(value==='source budget is expired or insufficient')return approvalFailureMessage(value);
  if(value==='an application for this purpose is already pending')return '该事项已有未完成申请，请在“我的申请”中继续处理；执行失败的原单需先修正或关闭。';
  if(value==='no active responsible approver is configured')return '当前没有可用的审批人，请联系运营配置其他有效审批人；本人不能审批自己的申请。';
  if(value==='only an approved or failed execution may be closed')return '只能关闭尚未生效的已批准或执行失败申请，请刷新确认状态。';
  if(status===401&&path.includes('/local-octop/imports')&&value==='API key does not match')return '完整密钥与所选记录不匹配，请核对后重试。';
  if(status===401)return path.endsWith('/auth/login')?'账号或密码不正确，请核对后重试。':value==='login required'?'请先登录企业账号后继续。':'登录已过期，请重新登录后继续。';
  if(status===403){
    if(path.endsWith('/auth/setup'))return '安装口令无效，请向安装负责人核对后重试。';
    if(/member is disabled|organization is disabled/.test(value))return '账号或所属组织已停用或到期，请联系运营管理员确认。';
    if(/environment enablement|upstream validation/.test(value))return '当前环境未开启外部模型连接验证。请联系运营管理员确认外呼授权与配置后重试。';
    if(/operator/.test(value))return '此操作需要运营权限，请由运营管理员处理。';
    if(/approval|responsible|self approval/.test(value))return '当前审批职责已变化，或你不能审批本人申请。请刷新申请，确认当前处理人。';
    if(/application.*owner|application.*scope/.test(value))return '应用负责人已变化，当前账号无法继续管理。请返回应用列表查看当前职责。';
    if(/project.*manager/.test(value))return '项目负责人已变化。请刷新项目，由当前项目经理继续处理。';
    if(/key/.test(value))return '这把密钥不在当前职责范围内。应用交接后，请由新负责人管理。';
    return /[\u4e00-\u9fff]/.test(value)?value:'当前账号无权继续此操作。请刷新页面，或联系运营管理员确认权限。';
  }
  if(status===409&&/preview/.test(value))return '内容已更新，当前影响预览已失效。请重新提交并核对最新影响后再确认。';
  if(path.includes('/agent-instances')&&status===409)return /in progress/.test(value)?'Agent 的另一项操作正在进行，请稍后刷新状态。':'Agent 暂未就绪，请刷新状态确认结果；启动失败时可重新启动恢复。';
  if(status>=500)return '服务暂时无法完成请求。请稍后刷新结果，确认是否已生效后再重试。';
  return value||`请求未完成（HTTP ${status}），请稍后重试。`;
}
export async function api<T>(path:string,body?:unknown):Promise<T>{
  let response:Response;
  try{response=await fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',credentials:'include',headers:body===undefined?undefined:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
  catch{throw new ApiError('连接已中断，请稍后重试。若刚才提交过操作，请先刷新结果确认是否已生效。',0);}
  let value;
  try{value=await response.json();}catch{throw new ApiError(response.ok?'结果暂时无法读取，请先刷新确认是否已生效，再决定是否重试。':readableError(response.status,null,path),response.ok?502:response.status);}
  if(!response.ok)throw new ApiError(readableError(response.status,value?.message,path),response.status);
  return value as T;
}
export const loadWorkspace=()=>api<PlatformSnapshot>('/api/v1/platform/state');
export interface Preview { impact:Record<string,unknown>;revision:number;previewToken:string }
export const previewCommand=(command:PlatformCommand)=>api<Preview>('/api/v1/platform/preview',command);
export const executeCommand=(command:PlatformCommand)=>api<{result:unknown;revision:number;replayed:boolean}>('/api/v1/platform/commands',command);
