import { isIP } from 'node:net';

/** Explicit network allowlist only; never trust a caller-selected hop count or all peers. */
export const parseTrustedProxies = (value: string | undefined): string[] => {
  if (!value?.trim()) return [];
  return value.split(',').map(raw => {
    const cidr = raw.trim();
    const [address, prefix, extra] = cidr.split('/');
    const version = isIP(address);
    const max = version === 4 ? 32 : 128;
    if (!version || extra !== undefined || (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > max))) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain explicit IP addresses or CIDRs with nonzero prefixes');
    }
    return cidr;
  });
};
