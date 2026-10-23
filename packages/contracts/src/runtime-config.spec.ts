import {describe,it,expect} from 'vitest';
import {databaseSchema,runtimeMode,validateRuntimeConfig} from './runtime-config.js';
const config={PLATFORM_MODE:'production',STORE_MODE:'postgres',DATABASE_URL:'postgresql://user:example@db/platform',DATABASE_SCHEMA:'signal_atlas',SERVICE_TOKEN:'a'.repeat(40),BOOTSTRAP_TOKEN:'b'.repeat(40),WEB_ORIGIN:'https://atlas.example.test',COOKIE_SECURE:'true',CONTROL_PLANE_URL:'http://control:4001',GATEWAY_JOURNAL_DIR:'/data/gateway'};
describe('explicit production boundaries before side effects',()=>{
  it('defaults to development, infers production from NODE_ENV and rejects unknown modes',()=>{expect(runtimeMode({})).toBe('development');expect(runtimeMode({NODE_ENV:'production'})).toBe('production');expect(()=>runtimeMode({PLATFORM_MODE:'prod'})).toThrow();expect(validateRuntimeConfig({},'control-plane')).toBe('development');expect(databaseSchema({DATABASE_SCHEMA:''})).toBeUndefined();});
  it('accepts configured production roles without including credentials in its output',()=>{expect(validateRuntimeConfig(config,'control-plane')).toBe('production');expect(validateRuntimeConfig(config,'gateway')).toBe('production');});
  it.each(['SERVICE_TOKEN','BOOTSTRAP_TOKEN','WEB_ORIGIN','DATABASE_URL','DATABASE_SCHEMA','COOKIE_SECURE'])('rejects missing control-plane %s',key=>{expect(()=>validateRuntimeConfig({...config,[key]:''},'control-plane')).toThrow();});
  it('rejects fixtures, mode downgrades, schema injection and permissive browser origins',()=>{
    for(const overrides of [{STORE_MODE:'memory'},{SERVICE_TOKEN:'local-service-token'},{DEV_LOGIN:'true'},{PGOPTIONS:'-c search_path=public'},{DATABASE_SCHEMA:'public;drop schema x'},{WEB_ORIGIN:'https://atlas.example.test/path'},{BOOTSTRAP_TOKEN:config.SERVICE_TOKEN}])expect(()=>validateRuntimeConfig({...config,...overrides},'control-plane')).toThrow();
    for(const url of ['file:///tmp','http://user:secret@control:4001','http://control:4001/path'])expect(()=>validateRuntimeConfig({...config,CONTROL_PLANE_URL:url},'gateway')).toThrow();
    expect(()=>validateRuntimeConfig({...config,GATEWAY_JOURNAL_DIR:''},'gateway')).toThrow();
  });
});
