import { extractClientIp, isIpWhitelisted } from './ip-whitelist.util';

describe('ip-whitelist.util', () => {
  it('should extract the first x-forwarded-for address', () => {
    expect(
      extractClientIp({
        headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
        ip: '10.0.0.2',
      }),
    ).toBe('203.0.113.10');
  });

  it('should match exact IP and IPv4-mapped IPv6 addresses', () => {
    expect(isIpWhitelisted('::ffff:203.0.113.10', ['203.0.113.10'])).toBe(true);
  });

  it('should match IPv4 CIDR entries', () => {
    expect(isIpWhitelisted('203.0.113.42', ['203.0.113.0/24'])).toBe(true);
  });

  it('should reject non-matching IP addresses', () => {
    expect(isIpWhitelisted('198.51.100.42', ['203.0.113.0/24'])).toBe(false);
  });
});
