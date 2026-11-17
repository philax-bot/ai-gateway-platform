import {BadRequestException,ConflictException} from '@nestjs/common';
import type {MediaJob,MediaJobReceipt,MediaJobUpdate} from '@ai-gateway/contracts';
export function jobId(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))throw new BadRequestException('invalid job id');return value;}
export function jobResult(value:unknown):Record<string,unknown>|null {
  if(value===null||value===undefined)return null;if(typeof value!=='object'||Array.isArray(value))throw new BadRequestException('invalid job result');
  const raw=value as Record<string,unknown>,result:Record<string,unknown>={};
  for(const key of ['url','seconds','progress','content_type','cancel_requested','cancel_uncertain']){const v=raw[key];if(v===undefined)continue;if(key==='cancel_requested'||key==='cancel_uncertain'){if(typeof v!=='boolean')throw new BadRequestException('invalid cancellation indicator');}else if(key==='seconds'||key==='progress'){if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e9)throw new BadRequestException('invalid job metric');}else if(typeof v!=='string'||v.length>4096)throw new BadRequestException('invalid job result field');result[key]=v;}
  return result;
}
export function jobReceipt(raw:MediaJobReceipt):MediaJobReceipt{
  jobId(raw?.id);if(typeof raw.upstreamId!=='string'||raw.upstreamId.length<1||raw.upstreamId.length>1000||/[\u0000-\u001f]/.test(raw.upstreamId)||!['queued','in_progress'].includes(raw.status))throw new BadRequestException('invalid video receipt');return {id:raw.id,upstreamId:raw.upstreamId,status:raw.status,result:jobResult(raw.result)};
}
export function jobUpdate(raw:MediaJobUpdate):MediaJobUpdate {
  jobId(raw?.id);
  if(raw.expectedRevision!==undefined&&(!Number.isSafeInteger(raw.expectedRevision)||raw.expectedRevision<0))throw new BadRequestException('invalid job revision');if(raw.cancelToken!==undefined)jobId(raw.cancelToken);
  jobId(raw?.id);if(!['queued','in_progress','completed','failed','cancelled'].includes(raw.status)||raw.errorCode!==undefined&&raw.errorCode!==null&&!/^[a-zA-Z0-9_-]{1,100}$/.test(raw.errorCode))throw new BadRequestException('invalid video update');return {id:raw.id,status:raw.status,result:jobResult(raw.result),errorCode:raw.errorCode??null,settled:raw.settled===true,expectedRevision:raw.expectedRevision,cancelToken:raw.cancelToken};
}

/** Receipt retries only attach the upstream identity once; they never rewind observations. */
export function applyJobReceipt(job:MediaJob,v:MediaJobReceipt){
  if(job.upstreamId&&job.upstreamId!==v.upstreamId)throw new ConflictException('upstream job identity changed');
  if(job.upstreamId)return false;
  job.upstreamId=v.upstreamId;
  if(!job.finishedAt&&!job.settled){job.status=v.status;job.result={...job.result,...v.result};}
  job.updatedAt=new Date().toISOString();job.revision=(job.revision??0)+1;return true;
}
export function applyJobUpdate(job:MediaJob,v:MediaJobUpdate){
  if(job.settled)return false;
  if(v.expectedRevision!==undefined&&v.expectedRevision!==(job.revision??0))return false;
  if(v.cancelToken&&job.cancelOperation?.token!==v.cancelToken)return false;
  if(job.finishedAt){if(v.settled!==true||v.status!==job.status)return false;job.settled=true;}
  else {
    const at=new Date().toISOString();
    job.status=job.status==='in_progress'&&v.status==='queued'?'in_progress':v.status;
    job.result={...job.result,...v.result};job.errorCode=v.errorCode??null;
    if(['completed','failed','cancelled'].includes(job.status))job.finishedAt=at;
    if(v.settled)job.settled=true;
  }
  if(v.cancelToken)delete job.cancelOperation;
  job.updatedAt=new Date().toISOString();job.revision=(job.revision??0)+1;return true;
}
export function claimJobCancellation(job:MediaJob,token:string){
  jobId(token);
  if(job.finishedAt||!job.upstreamId||job.settled)return false;
  if(job.result?.cancel_requested===true&&job.result.cancel_uncertain===false)return false;
  if(job.cancelOperation&&Date.parse(job.cancelOperation.expiresAt)>Date.now())return false;
  job.cancelOperation={token,expiresAt:new Date(Date.now()+30000).toISOString()};
  job.result={...job.result,cancel_requested:true,cancel_uncertain:true};job.updatedAt=new Date().toISOString();job.revision=(job.revision??0)+1;return true;
}
