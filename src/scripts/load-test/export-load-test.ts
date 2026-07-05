/**
 * Export load-test runner — validates streaming export at scale (the "1M+
 * records" requirement from docs/17-data-export.md).
 *
 * It triggers a real export against a tenant that already has data, polls the
 * job to completion, and reports wall-clock + throughput. Optionally downloads
 * the result to verify it materializes.
 *
 * Auth model (same as the import load-test): the API resolves tenant + user
 * from the `sid` session cookie against the tenant subdomain in the base URL.
 *
 * Uses only Node ≥18 built-ins (global fetch) — no extra deps.
 *
 * Usage:
 *   CRM_BASE_URL=https://acme.crmsaudi.dev/api/v1 \
 *   CRM_SID=<session-id> \
 *   EXPORT_MODULE=contacts EXPORT_FORMAT=csv \
 *   npx ts-node src/scripts/load-test/export-load-test.ts
 *
 * Optional env:
 *   EXPORT_IDS=id1,id2         export only these records (default: all)
 *   EXPORT_DOWNLOAD=1          download the result and report bytes
 *   CRM_POLL_MS=2000           status poll interval
 *   CRM_TIMEOUT_MS=1800000     max wait
 *   CRM_INSECURE_TLS=1         allow self-signed certs (staging)
 */

// Mark this file as a module (it uses only globals) so its top-level
// declarations don't leak into the global script scope.
export {};

interface Config {
  baseUrl: string;
  cookie: string;
  module: string;
  format: 'csv' | 'xlsx';
  ids?: string[];
  download: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
}

function configFromEnv(): Config {
  const baseUrl = (process.env.CRM_BASE_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error('CRM_BASE_URL is required, e.g. https://acme.host/api/v1');
  }
  const cookie =
    process.env.CRM_COOKIE ??
    (process.env.CRM_SID ? `sid=${process.env.CRM_SID}` : '');
  if (!cookie) {
    throw new Error('Set CRM_COOKIE="sid=..." (or CRM_SID=...)');
  }
  if (process.env.CRM_INSECURE_TLS === '1') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  const module = process.env.EXPORT_MODULE ?? 'contacts';
  const format = (process.env.EXPORT_FORMAT ?? 'csv') as 'csv' | 'xlsx';
  const ids = process.env.EXPORT_IDS
    ? process.env.EXPORT_IDS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  return {
    baseUrl,
    cookie,
    module,
    format,
    ids,
    download: process.env.EXPORT_DOWNLOAD === '1',
    pollIntervalMs: Number(process.env.CRM_POLL_MS ?? 2000),
    timeoutMs: Number(process.env.CRM_TIMEOUT_MS ?? 30 * 60 * 1000),
  };
}

async function expectOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `${label} failed: HTTP ${res.status} ${body.slice(0, 300)}`,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PollResult {
  status: string;
  progress: any;
  result: any;
  failedReason?: string;
}

async function pollUntilDone(
  base: string,
  jobId: string,
  h: Record<string, string>,
  cfg: Config,
  startedAt: number,
): Promise<any> {
  let lastProcessed = -1;
  while (true) {
    if (Date.now() - startedAt > cfg.timeoutMs) {
      throw new Error(`Timed out after ${cfg.timeoutMs}ms (job ${jobId})`);
    }
    await sleep(cfg.pollIntervalMs);
    const stRes = await fetch(`${base}/export-status/${jobId}`, { headers: h });
    await expectOk(stRes, 'status');
    const st = (await stRes.json()) as PollResult;
    const processed = st.progress?.processed ?? 0;
    if (processed !== lastProcessed) {
      const pct = st.progress?.pct;
      console.log(
        `[export-load] ${st.status} processed=${processed}` +
          (pct != null ? ` (${pct}%)` : ''),
      );
      lastProcessed = processed;
    }
    if (st.status === 'completed') {
      return st.result;
    }
    if (st.status === 'failed') {
      throw new Error(`Export failed: ${st.failedReason ?? 'unknown'}`);
    }
  }
}

async function downloadResult(result: any, cfg: Config): Promise<void> {
  if (!cfg.download || !result?.downloadUrl) return;
  const dlUrl = result.downloadUrl.startsWith('http')
    ? result.downloadUrl
    : `${cfg.baseUrl.replace(/\/api\/v1$/, '')}${result.downloadUrl}`;
  const dlStart = Date.now();
  const dlRes = await fetch(dlUrl, { headers: { Cookie: cfg.cookie } });
  await expectOk(dlRes, 'download');
  const buf = Buffer.from(await dlRes.arrayBuffer());
  console.log(
    `[export-load] downloaded : ${buf.length} bytes in ${Date.now() - dlStart} ms`,
  );
}

async function run(): Promise<void> {
  const cfg = configFromEnv();
  const h = { Cookie: cfg.cookie, 'Content-Type': 'application/json' };
  const base = `${cfg.baseUrl}/${cfg.module}`;

  console.log(
    `[export-load] module=${cfg.module} format=${cfg.format} ` +
      `ids=${cfg.ids?.length ?? 'all'} base=${cfg.baseUrl}`,
  );

  const startedAt = Date.now();
  const startRes = await fetch(`${base}/export`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ format: cfg.format, ids: cfg.ids }),
  });
  await expectOk(startRes, 'start export');
  const { jobId } = (await startRes.json()) as { jobId: string };
  console.log(`[export-load] queued jobId=${jobId}`);

  const result = await pollUntilDone(base, jobId, h, cfg, startedAt);

  const elapsedMs = Date.now() - startedAt;
  const rows = result?.recordCount ?? 0;
  const throughput = rows > 0 ? Math.round(rows / (elapsedMs / 1000)) : 0;
  console.log('[export-load] ──────────────────────────────');
  console.log(`[export-load] records   : ${rows}`);
  console.log(`[export-load] elapsed   : ${elapsedMs} ms`);
  console.log(`[export-load] throughput: ${throughput} rows/s`);
  console.log(`[export-load] downloadUrl: ${result?.downloadUrl ?? 'n/a'}`);

  await downloadResult(result, cfg);
}

run().catch((err) => {
  console.error('[export-load] ERROR:', (err as Error).message);
  process.exit(1);
});
