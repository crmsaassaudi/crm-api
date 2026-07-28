import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'net';
import { lookup } from 'dns/promises';

/**
 * Thrown by {@link SsrfGuardService.safeFetch} when the initial URL or any
 * redirect hop targets a blocked address. Distinct from a transport error so
 * callers can report it as a permanent (non-retryable) failure.
 */
export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * SsrfGuardService — Server-Side Request Forgery protection for webhook URLs.
 *
 * Prevents users from configuring webhooks that hit internal/private IP addresses.
 * Steps:
 *   1. Parse URL → extract hostname
 *   2. DNS resolve hostname → get all IP addresses
 *   3. Check ALL resolved IPs against blocked CIDR ranges
 *   4. Block if ANY resolved IP is private/reserved
 *
 * Blocked ranges:
 *   - 127.0.0.0/8 (loopback)
 *   - 10.0.0.0/8 (private class A)
 *   - 172.16.0.0/12 (private class B)
 *   - 192.168.0.0/16 (private class C)
 *   - 169.254.0.0/16 (link-local)
 *   - 0.0.0.0/8 (default route)
 *   - ::1 (IPv6 loopback)
 *   - fc00::/7 (IPv6 private)
 *   - fe80::/10 (IPv6 link-local)
 */
@Injectable()
export class SsrfGuardService {
  private readonly logger = new Logger(SsrfGuardService.name);

  /**
   * Blocked private/reserved IPv4 ranges.
   * Each entry is [networkAddress (as 32-bit int), maskBits].
   */
  private readonly BLOCKED_IPV4_RANGES: Array<{
    network: number;
    mask: number;
    label: string;
  }> = [
    { network: this.ipToInt('127.0.0.0'), mask: 8, label: 'loopback' },
    { network: this.ipToInt('10.0.0.0'), mask: 8, label: 'private-A' },
    {
      network: this.ipToInt('100.64.0.0'),
      mask: 10,
      label: 'carrier-grade-nat',
    },
    { network: this.ipToInt('172.16.0.0'), mask: 12, label: 'private-B' },
    { network: this.ipToInt('192.168.0.0'), mask: 16, label: 'private-C' },
    { network: this.ipToInt('192.0.0.0'), mask: 24, label: 'ietf-protocol' },
    { network: this.ipToInt('169.254.0.0'), mask: 16, label: 'link-local' },
    { network: this.ipToInt('198.18.0.0'), mask: 15, label: 'benchmark' },
    { network: this.ipToInt('224.0.0.0'), mask: 4, label: 'multicast' },
    { network: this.ipToInt('240.0.0.0'), mask: 4, label: 'reserved' },
    { network: this.ipToInt('0.0.0.0'), mask: 8, label: 'default-route' },
    { network: this.ipToInt('255.255.255.255'), mask: 32, label: 'broadcast' },
  ];

  /**
   * Blocked IPv6 prefixes (simplified string matching).
   */
  private readonly BLOCKED_IPV6_PREFIXES = [
    '::1', // loopback
    'fc', // fc00::/7 unique local
    'fd', // fd00::/8 unique local
    'fe80', // fe80::/10 link-local
  ];

  /**
   * Validate a webhook URL for SSRF safety.
   *
   * @returns { safe: true } if URL targets a public host, or
   *          { safe: false, reason: string } if blocked
   */
  private readonly DNS_TIMEOUT_MS = 5_000;
  private readonly MAX_URL_LENGTH = 2_048;
  /** Redirect hops allowed by {@link safeFetch}; each one is re-validated. */
  private readonly MAX_REDIRECTS = 3;

  async validate(
    url: string,
  ): Promise<{ safe: boolean; reason?: string; resolvedIp?: string }> {
    // ── Step 0: Length guard ────────────────────────────────────────────
    if (url.length > this.MAX_URL_LENGTH) {
      return {
        safe: false,
        reason: `URL exceeds maximum length of ${this.MAX_URL_LENGTH} characters`,
      };
    }

    // ── Step 1: Parse URL ───────────────────────────────────────────────
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { safe: false, reason: `Invalid URL format` };
    }

    // Block non-HTTP(S) protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        safe: false,
        reason: `Unsupported protocol: ${parsed.protocol} (only http/https allowed)`,
      };
    }

    const hostname = parsed.hostname;
    if (!hostname) {
      return { safe: false, reason: 'Invalid URL: hostname is required' };
    }

    // ── Step 2: Check if hostname is a raw IP ───────────────────────────
    const normalizedIp = this.normalizeIp(hostname);
    if (normalizedIp) {
      const blocked = this.isBlockedIp(normalizedIp);
      if (blocked) {
        return {
          safe: false,
          reason: `SSRF blocked: ${hostname} is a private/reserved IP (${blocked})`,
        };
      }
      return { safe: true, resolvedIp: normalizedIp };
    }

    // Block localhost aliases
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return {
        safe: false,
        reason: 'SSRF blocked: localhost is not allowed for webhooks',
      };
    }

    // ── Step 3: DNS resolve and check all resolved IPs ──────────────────
    try {
      const results = await this.lookupWithTimeout(hostname);

      for (const result of results) {
        const blocked = this.isBlockedIp(result.address);
        if (blocked) {
          return {
            safe: false,
            reason: `SSRF blocked: ${hostname} resolves to private IP ${result.address} (${blocked})`,
          };
        }
      }

      return { safe: true, resolvedIp: results[0].address };
    } catch (dnsError: any) {
      // If DNS fails, it's safer to block than to allow
      this.logger.warn(
        `[SSRFGuard] DNS resolution failed for ${hostname}: ${dnsError.message}`,
      );
      return {
        safe: false,
        reason: `DNS resolution failed for ${hostname}: ${dnsError.message}`,
      };
    }
  }

  /**
   * Fetch a URL with SSRF protection that survives redirects.
   *
   * `fetch` defaults to `redirect: 'follow'`, which means validating only the
   * URL the user configured protects nothing: a public host answering
   * `302 Location: http://169.254.169.254/…` gets followed to the metadata
   * service without any further check. So redirects are handled here instead —
   * every hop is re-validated and re-pinned exactly like the first one.
   *
   * The caller keeps ownership of the abort signal (its own timeout), so a
   * redirect chain cannot extend the overall deadline.
   */
  async safeFetch(
    url: string,
    init: RequestInit,
    options?: { maxRedirects?: number },
  ): Promise<Response> {
    const maxRedirects = options?.maxRedirects ?? this.MAX_REDIRECTS;
    let currentUrl = url;
    let currentInit: RequestInit = { ...init, redirect: 'manual' };

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const check = await this.validate(currentUrl);
      if (!check.safe) {
        throw new SsrfBlockedError(
          hop === 0
            ? check.reason!
            : `redirect hop ${hop} to ${currentUrl} blocked: ${check.reason}`,
        );
      }

      const { fetchUrl, hostHeader } = this.pin(currentUrl, check.resolvedIp);
      const response = await fetch(fetchUrl, {
        ...currentInit,
        headers: hostHeader
          ? {
              ...(currentInit.headers as Record<string, string>),
              Host: hostHeader,
            }
          : currentInit.headers,
      });

      if (!this.isRedirect(response.status)) {
        return response;
      }

      const location = response.headers.get('location');
      // Release the connection before following: the body is never useful on a
      // redirect and leaving it open leaks a socket per hop.
      await response.body?.cancel().catch(() => {});

      if (!location) {
        throw new SsrfBlockedError(
          `HTTP ${response.status} redirect without a Location header`,
        );
      }

      currentUrl = new URL(location, currentUrl).toString();
      currentInit = this.rewriteForRedirect(currentInit, response.status);
    }

    throw new SsrfBlockedError(
      `Exceeded the maximum of ${maxRedirects} redirects starting from ${url}`,
    );
  }

  /**
   * Rewrite the request for the next hop, mirroring what `fetch` would do:
   * 303 (and 301/302 for anything other than GET/HEAD, per browser behaviour)
   * downgrade to GET and drop the body.
   */
  private rewriteForRedirect(init: RequestInit, status: number): RequestInit {
    const method = (init.method ?? 'GET').toUpperCase();
    const downgrades =
      status === 303 ||
      ((status === 301 || status === 302) &&
        method !== 'GET' &&
        method !== 'HEAD');

    if (!downgrades) return init;

    const { body: _dropped, ...rest } = init;
    return { ...rest, method: 'GET' };
  }

  /**
   * Swap the hostname for the IP we just validated and carry the original host
   * in a `Host` header, so DNS cannot be re-resolved to a different address
   * between the check and the connection (DNS rebinding).
   */
  private pin(
    url: string,
    resolvedIp?: string,
  ): { fetchUrl: string; hostHeader?: string } {
    if (!resolvedIp) return { fetchUrl: url };

    const parsed = new URL(url);
    const originalHost = parsed.host;
    parsed.hostname = resolvedIp.includes(':') ? `[${resolvedIp}]` : resolvedIp;
    return { fetchUrl: parsed.toString(), hostHeader: originalHost };
  }

  private isRedirect(status: number): boolean {
    return (
      status === 301 ||
      status === 302 ||
      status === 303 ||
      status === 307 ||
      status === 308
    );
  }

  private async lookupWithTimeout(
    hostname: string,
  ): Promise<Array<{ address: string; family: number }>> {
    let timeout: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        lookup(hostname, { all: true }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('DNS resolution timeout')),
            this.DNS_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * Check if an IP address falls within any blocked range.
   * @returns The range label if blocked, or null if safe
   */
  private isBlockedIp(ip: string): string | null {
    const normalizedIp = this.normalizeIp(ip);
    if (!normalizedIp) return 'invalid-ip';
    const version = isIP(normalizedIp);

    if (version === 4) {
      const ipInt = this.ipToInt(normalizedIp);
      for (const range of this.BLOCKED_IPV4_RANGES) {
        const maskBits = 0xffffffff << (32 - range.mask);
        if ((ipInt & maskBits) === (range.network & maskBits)) {
          return range.label;
        }
      }
    } else if (version === 6) {
      const normalized = normalizedIp.toLowerCase();
      if (normalized === '::1') return 'ipv6-loopback';
      for (const prefix of this.BLOCKED_IPV6_PREFIXES) {
        if (normalized.startsWith(prefix)) return `ipv6-${prefix}`;
      }
    }

    return null;
  }

  private normalizeIp(hostnameOrIp: string): string | null {
    const trimmed = hostnameOrIp.trim().replace(/(?:^\[)|(?:\]$)/g, '');
    if (isIP(trimmed)) return trimmed;

    const ipv4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
    if (ipv4Mapped && isIP(ipv4Mapped[1]) === 4) {
      return ipv4Mapped[1];
    }

    return null;
  }

  /**
   * Convert an IPv4 address string to a 32-bit integer.
   */
  private ipToInt(ip: string): number {
    const parts = ip.split('.').map(Number);
    return (
      ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
    );
  }
}
