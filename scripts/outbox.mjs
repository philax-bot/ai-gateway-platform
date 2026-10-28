const args=process.argv.slice(2),command=args.shift();
function option(name){const index=args.indexOf(name);if(index<0)return null;const value=args[index+1];args.splice(index,2);return value;}
try{
  const requestId=option('--request'),reason=option('--reason'),admissionAttemptId=option('--attempt');
  if(!['status','inspect','retry'].includes(command)||args.length||admissionAttemptId&&command!=='retry'||command==='retry'&&(!requestId||!reason))throw new Error('Usage: outbox.mjs status | inspect [--request ID] | retry --request ID [--attempt ID] --reason TEXT');
  if(!process.env.SERVICE_TOKEN)throw new Error('SERVICE_TOKEN is required in the environment');
  const base=new URL(process.env.GATEWAY_OPERATIONS_URL??`http://127.0.0.1:${process.env.PORT??4000}`);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('GATEWAY_OPERATIONS_URL must be an HTTP(S) origin');
  const url=new URL(command==='retry'?'/internal/v1/outbox/retry':'/internal/v1/outbox',base);
  if(requestId&&command!=='retry')url.searchParams.set('requestId',requestId);
  const response=await fetch(url,{method:command==='retry'?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{authorization:`Bearer ${process.env.SERVICE_TOKEN}`,'content-type':'application/json'},...(command==='retry'?{body:JSON.stringify({requestId,reason,...(admissionAttemptId?{admissionAttemptId}:{})})}:{})});
  const result=await response.json();
  if(!response.ok)throw new Error(`outbox operation failed (${response.status}, ${result.error?.type??'unknown'})`);
  console.log(JSON.stringify(command==='status'?result.summary:result,null,2));
  if(command==='retry'&&!result.delivered)process.exitCode=1;
}catch(error){console.error(error instanceof Error?error.message:'outbox operation failed');process.exitCode=1;}
