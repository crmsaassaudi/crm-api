import { SsrfBlockedError, SsrfGuardService } from './ssrf-guard.service';

/**
 * Covers the redirect path of safeFetch. Validating only the configured URL is
 * not protection: `fetch` follows redirects by default, so a public host could
 * bounce the worker onto 169.254.169.254 and hand back instance credentials.
 */
describe('SsrfGuardService.safeFetch redirect handling', () => {
  let guard: SsrfGuardService;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  /** A 3xx with a Location, shaped like the bits safeFetch reads. */
  const redirectTo = (location: string, status = 302) =>
    ({
      status,
      ok: false,
      headers: { get: (h: string) => (h === 'location' ? location : null) },
      body: { cancel: () => Promise.resolve() },
    }) as unknown as Response;

  const ok = () =>
    ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: { cancel: () => Promise.resolve() },
    }) as unknown as Response;

  beforeEach(() => {
    guard = new SsrfGuardService();
    // Public hosts resolve to a public IP; the metadata host resolves to itself.
    jest.spyOn(guard, 'validate').mockImplementation((url: string) => {
      const host = new URL(url).hostname;
      if (host === '169.254.169.254') {
        return Promise.resolve({
          safe: false,
          reason:
            'SSRF blocked: 169.254.169.254 is a private/reserved IP (link-local)',
        });
      }
      return Promise.resolve({ safe: true, resolvedIp: '93.184.216.34' });
    });

    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('should refuse a redirect that points at a blocked address', async () => {
    fetchMock.mockResolvedValueOnce(
      redirectTo('http://169.254.169.254/latest/meta-data/'),
    );

    await expect(
      guard.safeFetch('https://evil.example.com/hook', { method: 'POST' }),
    ).rejects.toThrow(SsrfBlockedError);

    // The blocked hop must never reach the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should never delegates redirect following to fetch', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await guard.safeFetch('https://ok.example.com/hook', { method: 'POST' });

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('should follow a redirect to an allowed host and re-pins each hop', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo('https://second.example.com/next'))
      .mockResolvedValueOnce(ok());

    const response = await guard.safeFetch('https://first.example.com/hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(guard.validate).toHaveBeenCalledTimes(2);
    // Both hops connect to the validated IP with the real host in a header,
    // so DNS cannot be re-pointed between check and connect.
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toContain('93.184.216.34');
      expect(call[1].headers.Host).toBeDefined();
    }
    expect(fetchMock.mock.calls[0][1].headers.Host).toBe('first.example.com');
    expect(fetchMock.mock.calls[1][1].headers.Host).toBe('second.example.com');
  });

  it('should drop the body and downgrades to GET on a 303', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo('https://second.example.com/next', 303))
      .mockResolvedValueOnce(ok());

    await guard.safeFetch('https://first.example.com/hook', {
      method: 'POST',
      body: '{"secret":"value"}',
    });

    expect(fetchMock.mock.calls[1][1].method).toBe('GET');
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
  });

  it('should stop after the redirect budget instead of looping', async () => {
    fetchMock.mockResolvedValue(redirectTo('https://loop.example.com/again'));

    await expect(
      guard.safeFetch(
        'https://loop.example.com/again',
        { method: 'GET' },
        { maxRedirects: 2 },
      ),
    ).rejects.toThrow(/maximum of 2 redirects/);

    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 hops
  });

  it('should reject a 3xx with no Location rather than returning it as success', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: { get: () => null },
      body: { cancel: () => Promise.resolve() },
    } as unknown as Response);

    await expect(
      guard.safeFetch('https://ok.example.com/hook', { method: 'GET' }),
    ).rejects.toThrow(/without a Location header/);
  });
});
