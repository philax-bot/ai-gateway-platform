import type {CallErrorBucket,CallFilters} from './calls.js';

/**
 * Operator-facing names for recorded error codes.
 *
 * Codes come from three places with different vocabularies: the data plane
 * (protocol validation, deadline phases, upstream HTTP status), the control
 * plane (admission and settlement), and media jobs. Unknown codes are shown
 * as-is rather than folded into "其他", because the raw code is what an
 * operator pastes into a log search.
 */
const CALL_ERROR_LABELS:Record<string,string>={
  client_cancelled:'客户端取消',
  timeout:'调用超时',
  upstream_error:'上游错误',
  partial:'流式 / 部分异常',
  rejected_before_upstream:'生成前拒绝',
  rate_limited:'平台限流',
  insufficient_quota:'额度不足',
  no_quota:'无可扣额度',
  quota_insufficient:'额度不足',
  price_unknown:'价格未知',
  model_not_found:'模型不可用',
  key_unavailable:'密钥不可用',
  credential_missing:'缺少上游凭据',
  controlled_configuration_unavailable:'受控配置不可用',
  safety_policy_violation:'安全策略拦截',
  gateway_restarted:'网关重启中断',
  gateway_stopping:'网关停机中断',
  authorization_response_lost:'授权响应丢失',
  authorization_response_invalid:'授权响应无效',
  authorization_recovery_unavailable:'授权恢复不可用',
  authorization_recovery_rejected:'授权恢复被拒绝',
  authorization_owner_unverified:'授权归属未确认',
  invalid_request_error:'请求格式无效',
  unsupported_parameter:'不支持的参数',
  invalid_response:'上游响应无法解析',
  upstream_not_ready:'上游未就绪',
  upstream_http_connection:'上游连接失败',
  connection_failed:'上游连接失败',
  auth_failed:'上游鉴权失败',
  authentication_error:'上游鉴权失败',
  http_error:'上游 HTTP 错误',
  tool_response_missing:'工具结果缺失',
  chat_cancel_failed:'取消未确认',
  video_submission_uncertain:'视频提交结果未知',
  video_generation_failed:'视频生成失败',
  video_cancelled:'视频任务取消',
  video_reservation_released:'视频预占已释放',
  acceptance_interrupted:'接入验收中断',
  runtime_not_confirmed:'运行态未确认',
  publication_interrupted:'发布中断',
  operation_superseded:'操作被替代',
  operation_interrupted:'操作中断',
};
const TIMEOUT_PHASES:Record<string,string>={first_byte:'上游首字节超时',idle:'上游空闲超时',total:'上游总时限超时'};

/** `unknown` is a state, not a code: missing evidence is never rendered as a cause. */
export function describeCallError(code:string|null|undefined):{label:string;known:boolean}{
  if(!code)return {label:'错误码未采集',known:false};
  const timeout=/^upstream_(first_byte|idle|total)_timeout$/.exec(code);
  if(timeout)return {label:TIMEOUT_PHASES[timeout[1]],known:true};
  const status=/^upstream_http_(\d{3})$/.exec(code);
  if(status)return {label:`上游 HTTP ${status[1]}`,known:true};
  return Object.hasOwn(CALL_ERROR_LABELS,code)
    ?{label:CALL_ERROR_LABELS[code],known:true}
    :{label:code,known:false};
}

/**
 * The only supported way to drill from a distribution row into the call list.
 * The window is passed in by the caller (the monitoring snapshot window), so the
 * list keeps the exact bounds the distribution was counted over.
 */
export function callErrorFilter(bucket:Pick<CallErrorBucket,'serviceId'|'modelId'|'outcome'|'errorCode'>,window:{from:string|null;to:string|null}):CallFilters{
  const filter:CallFilters={modelId:bucket.modelId,outcome:bucket.outcome};
  if(window.from)filter.from=window.from;
  if(window.to)filter.to=window.to;
  if(bucket.serviceId)filter.serviceId=bucket.serviceId; else filter.serviceMissing='true';
  if(bucket.errorCode)filter.errorCode=bucket.errorCode; else filter.errorCodeMissing='true';
  return filter;
}
