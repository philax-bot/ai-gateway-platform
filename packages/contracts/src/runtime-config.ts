export type RuntimeMode='development'|'production';
export function runtimeMode(env:Record<string,string|undefined>):RuntimeMode{
  const mode=env.PLATFORM_MODE??(env.NODE_ENV==='production'?'production':'development');
  if(mode!=='development'&&mode!=='production')throw new Error('PLATFORM_MODE must be development or production');
  return mode;
}
export function databaseSchema(env:Record<string,string|undefined>):string|undefined{
  const schema=env.DATABASE_SCHEMA||undefined;
  if(schema!==undefined&&!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))throw new Error('DATABASE_SCHEMA must be a lowercase PostgreSQL identifier');
  return schema;
}
/** Validate before any database writes, network listeners or journal creation. Never echo secret values. */
export function validateRuntimeConfig(env:Record<string,string|undefined>,role:'control-plane'|'gateway'):RuntimeMode{
  const mode=runtimeMode(env);databaseSchema(env);if(mode!=='production')return mode;
  const secret=(key:string)=>{const value=env[key];if(!value||value.trim()!==value||value.length<32||/^(local-|change[-_]?me|replace[-_]?me)/i.test(value))throw new Error(`${key} must be a non-default secret of at least 32 characters in production`);};
  secret('SERVICE_TOKEN');
  let origin:URL;try{origin=new URL(env.WEB_ORIGIN??'');}catch{throw new Error('WEB_ORIGIN must be an HTTPS origin in production');}
  if(origin.protocol!=='https:'||origin.origin!==env.WEB_ORIGIN||origin.username||origin.password)throw new Error('WEB_ORIGIN must be an HTTPS origin in production');
  if(role==='control-plane'){
    if(env.STORE_MODE!=='postgres')throw new Error('STORE_MODE must be postgres in production');
    let db:URL;try{db=new URL(env.DATABASE_URL??'');}catch{throw new Error('DATABASE_URL is required in production');}
    if(!['postgres:','postgresql:'].includes(db.protocol)||!db.hostname||!db.pathname||db.pathname==='/')throw new Error('DATABASE_URL must identify a PostgreSQL database');
    if(!databaseSchema(env))throw new Error('DATABASE_SCHEMA is required in production');
    if(env.PGOPTIONS)throw new Error('Use DATABASE_SCHEMA instead of PGOPTIONS in production');
    secret('BOOTSTRAP_TOKEN');if(env.BOOTSTRAP_TOKEN===env.SERVICE_TOKEN)throw new Error('BOOTSTRAP_TOKEN and SERVICE_TOKEN must differ');
    if(env.DEV_LOGIN==='true')throw new Error('DEV_LOGIN is unavailable in production');
    if(env.COOKIE_SECURE!=='true')throw new Error('COOKIE_SECURE must be true in production');
  }else{
    let cp:URL;try{cp=new URL(env.CONTROL_PLANE_URL??'');}catch{throw new Error('CONTROL_PLANE_URL is required in production');}
    if(!['http:','https:'].includes(cp.protocol)||cp.username||cp.password||cp.search||cp.hash||cp.pathname!=='/')throw new Error('CONTROL_PLANE_URL must be an HTTP(S) origin');
    if(!env.GATEWAY_JOURNAL_DIR)throw new Error('GATEWAY_JOURNAL_DIR is required in production');
  }
  return mode;
}
