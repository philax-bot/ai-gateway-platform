/** Only failures known to precede any HTTP request can prove zero upstream usage. */
export function definitelyNotSent(error:unknown,depth=0):boolean{
  if(depth>5||!error||typeof error!=='object')return false;
  const value=error as {code?:unknown;cause?:unknown;errors?:unknown[]};
  if(Array.isArray(value.errors)&&value.errors.length)return value.errors.every(error=>definitelyNotSent(error,depth+1));
  if(['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT'].includes(String(value.code)))return true;
  return value.cause?definitelyNotSent(value.cause,depth+1):false;
}
