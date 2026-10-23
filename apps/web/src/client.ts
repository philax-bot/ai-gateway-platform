import type { PlatformCommand, PlatformSnapshot } from '@ai-gateway/contracts';
const base=(import.meta.env.VITE_CONTROL_PLANE_URL??'http://127.0.0.1:4001').replace(/\/+$/,'');
export const gatewayBaseUrl=(import.meta.env.VITE_GATEWAY_URL??'http://127.0.0.1:4000').replace(/\/+$/,'');
export const openAiBaseUrl=`${gatewayBaseUrl}/v1`;
export class ApiError extends Error { constructor(message:string,readonly status:number){super(message);} }
function readableError(status:number,message:unknown,path:string):string{
  const value=Array.isArray(message)?message.join('；'):typeof message==='string'?message:'';
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
