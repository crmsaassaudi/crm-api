import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'net';
import { lookup } from 'dns/promises';

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
    { network: this.ipToInt('172.16.0.0'), mask: 12, label: 'private-B' },
    { network: this.ipToInt('192.168.0.0'), mask: 16, label: 'private-C' },
    { network: this.ipToInt('169.254.0.0'), mask: 16, label: 'link-local' },
    { network: this.ipToInt('0.0.0.0'), mask: 8, label: 'default-route' },
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
  async validate(url: string): Promise<{ safe: boolean; reason?: string }> {
    // ── Step 1: Parse URL ───────────────────────────────────────────────
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { safe: false, reason: `Invalid URL format: ${url}` };
    }

    // Block non-HTTP(S) protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        safe: false,
        reason: `Unsupported protocol: ${parsed.protocol} (only http/https allowed)`,
      };
    }

    const hostname = parsed.hostname;

    // ── Step 2: Check if hostname is a raw IP ───────────────────────────
    if (isIP(hostname)) {
      const blocked = this.isBlockedIp(hostname);
      if (blocked) {
        return {
          safe: false,
          reason: `SSRF blocked: ${hostname} is a private/reserved IP (${blocked})`,
        };
      }
      return { safe: true };
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
      const results = await lookup(hostname, { all: true });

      for (const result of results) {
        const blocked = this.isBlockedIp(result.address);
        if (blocked) {
          return {
            safe: false,
            reason: `SSRF blocked: ${hostname} resolves to private IP ${result.address} (${blocked})`,
          };
        }
      }

      return { safe: true };
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
   * Check if an IP address falls within any blocked range.
   * @returns The range label if blocked, or null if safe
   */
  private isBlockedIp(ip: string): string | null {
    const version = isIP(ip);

    if (version === 4) {
      const ipInt = this.ipToInt(ip);
      for (const range of this.BLOCKED_IPV4_RANGES) {
        const maskBits = 0xffffffff << (32 - range.mask);
        if ((ipInt & maskBits) === (range.network & maskBits)) {
          return range.label;
        }
      }
    } else if (version === 6) {
      const normalized = ip.toLowerCase();
      if (normalized === '::1') return 'ipv6-loopback';
      for (const prefix of this.BLOCKED_IPV6_PREFIXES) {
        if (normalized.startsWith(prefix)) return `ipv6-${prefix}`;
      }
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
