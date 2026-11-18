import { FastifyAdapter } from '@nestjs/platform-fastify';
import { describe, expect, it } from 'vitest';
import { trustedProxyAddress } from './http-proxy';

describe('control-plane proxy address', () => {
  it('uses a forwarded client address only for the configured proxy peer', async () => {
    const adapter = new FastifyAdapter({trustProxy: trustedProxyAddress('192.0.2.2')});
    const server = adapter.getInstance();
    server.get('/address', request => ({ip: request.ip}));
    const headers = {'x-forwarded-for':'198.51.100.10'};
    try {
      const proxy = await server.inject({url:'/address', remoteAddress:'::ffff:192.0.2.2', headers});
      const direct = await server.inject({url:'/address', remoteAddress:'192.0.2.3', headers});
      expect(proxy.json()).toEqual({ip:'198.51.100.10'});
      expect(direct.json()).toEqual({ip:'192.0.2.3'});
    } finally {
      await server.close();
    }
  });

  it('defaults to the socket address and rejects non-address settings', () => {
    expect(trustedProxyAddress(undefined)).toBe(false);
    expect(() => trustedProxyAddress('true')).toThrow('single proxy IP address');
  });
});
