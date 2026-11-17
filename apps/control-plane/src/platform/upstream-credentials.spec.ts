import {afterEach,describe,expect,it} from 'vitest';
import {initialWorkspace} from './seed';
import {saveUpstreamCredential,resolveUpstreamCredential,publicUpstreamCredential} from './upstream-credentials';
import {poolSimulationOptions} from '../store/admission';
import type {AuthorizeRequest} from '@ai-gateway/contracts';

afterEach(()=>{delete process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY;});
describe('encrypted versioned upstream credentials',()=>{
  it('pins versions through rotation and disable, exposes metadata only and rejects tampering',()=>{
    process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY=Buffer.alloc(32,11).toString('base64');
    const state=initialWorkspace(),created=saveUpstreamCredential(state,{name:'local credential',providerId:'openai-compatible',secret:'local-secret-original'});
    const credential=state.upstreamCredentials![0],service=state.services[0];service.credentialId=created.id;
    const original={id:created.id,version:1};
    expect(JSON.stringify(credential)).not.toContain('local-secret-original');
    expect(JSON.stringify(publicUpstreamCredential(credential))).not.toContain('ciphertext');
    expect(resolveUpstreamCredential(state,original)).toBe('local-secret-original');
    saveUpstreamCredential(state,{id:created.id,secret:'local-secret-rotated'});
    expect(service.verification).toBe('unverified');
    expect(resolveUpstreamCredential(state,original)).toBe('local-secret-original');
    expect(resolveUpstreamCredential(state,{id:created.id,version:2})).toBe('local-secret-rotated');
    saveUpstreamCredential(state,{id:created.id,active:false});
    expect(resolveUpstreamCredential(state,original)).toBe('local-secret-original');
    service.verification='passed';state.pools[0].entries[0].open=true;
    const input:AuthorizeRequest={requestId:'simulate-credential',idempotencyKey:'simulate-credential',identity:{subjectType:'application',subjectId:'simulation',credentialId:'simulation',organizationId:state.tenantId,projectId:null},modelId:state.definitions[0].modelId,purpose:'application',mode:'chat',policyVersion:'simulation',estimatedInputTokens:0,maxOutputTokens:1};
    expect(poolSimulationOptions(state,input,state.pools[0].id)[0].reason).toBe('service_unavailable');
    credential.versions[0].tag=Buffer.alloc(16).toString('base64');
    expect(()=>resolveUpstreamCredential(state,original)).toThrow('credential decryption failed');
  });
  it('requires a valid deployment key and provider association',()=>{
    const state=initialWorkspace();
    expect(()=>saveUpstreamCredential(state,{name:'missing key',providerId:'openai-compatible',secret:'local fixture'})).toThrow('encryption key');
    expect(()=>saveUpstreamCredential(state,{name:'unknown provider',providerId:'missing',secret:'local fixture'})).toThrow('provider not found');
  });
});
