import {afterEach,expect,it,vi} from 'vitest';
import {LocalOctopRuntime} from './local-octop.runtime';
afterEach(()=>vi.unstubAllEnvs());
it('requires explicit opt-in, development mode and a loopback control-plane host',()=>{
  const runtime=new LocalOctopRuntime();vi.stubEnv('OCTOP_MANAGED_ENABLED','false');expect(runtime.enabled).toBe(false);
  vi.stubEnv('OCTOP_MANAGED_ENABLED','true');vi.stubEnv('PLATFORM_MODE','production');expect(runtime.enabled).toBe(false);
  vi.stubEnv('PLATFORM_MODE','development');vi.stubEnv('HOST','0.0.0.0');expect(runtime.enabled).toBe(false);
  vi.stubEnv('HOST','127.0.0.1');expect(runtime.enabled).toBe(true);
});
