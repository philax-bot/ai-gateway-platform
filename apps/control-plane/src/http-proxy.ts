import { isIP } from 'node:net';

export function trustedProxyAddress(value: string | undefined): string | false {
  if (!value) return false;
  if (!isIP(value)) throw new Error('CONTROL_PLANE_TRUST_PROXY must be a single proxy IP address');
  return value;
}
