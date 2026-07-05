import { isIP } from 'net';

const IPV4_MAPPED_IPV6_PREFIX = '::ffff:';

export function extractClientIp(request: {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  connection?: { remoteAddress?: string };
}): string {
  const forwardedFor = request.headers?.['x-forwarded-for'];
  const firstForwardedIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(',')[0];

  return normalizeIp(
    firstForwardedIp ??
      request.ip ??
      request.socket?.remoteAddress ??
      request.connection?.remoteAddress ??
      '',
  );
}

export function isIpWhitelisted(
  clientIp: string,
  whitelistedIPs: string[],
): boolean {
  const normalizedClientIp = normalizeIp(clientIp);
  if (!normalizedClientIp) return false;

  return whitelistedIPs.some((entry) =>
    isIpWhitelistEntryMatch(normalizedClientIp, entry),
  );
}

function isIpWhitelistEntryMatch(clientIp: string, entry: string): boolean {
  const normalizedEntry = normalizeIp(entry);
  if (!normalizedEntry) return false;

  if (!normalizedEntry.includes('/')) {
    return normalizedEntry === clientIp;
  }

  return isIpv4CidrMatch(clientIp, normalizedEntry);
}

function isIpv4CidrMatch(clientIp: string, cidr: string): boolean {
  const [rangeIp, rawPrefixLength] = cidr.split('/');
  const prefixLength = Number(rawPrefixLength);

  if (
    !Number.isInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > 32 ||
    isIP(clientIp) !== 4 ||
    isIP(rangeIp) !== 4
  ) {
    return false;
  }

  const client = ipv4ToNumber(clientIp);
  const range = ipv4ToNumber(rangeIp);
  const mask =
    prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;

  return (client & mask) === (range & mask);
}

function ipv4ToNumber(ip: string): number {
  return ip
    .split('.')
    .reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

function normalizeIp(value: string): string {
  let ip = value.trim().toLowerCase();
  if (!ip) return '';

  if (ip.startsWith(IPV4_MAPPED_IPV6_PREFIX)) {
    ip = ip.slice(IPV4_MAPPED_IPV6_PREFIX.length);
  }

  return ip;
}
