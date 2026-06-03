/**
 * Thin HTTP client used by the contact-import load-test scenarios.
 *
 * Auth model: the API resolves tenant + user from the `sid` session cookie
 * (see TenantInterceptor) against the tenant subdomain in the base URL. So a
 * load run needs (1) the tenant's API base URL and (2) a valid `sid` cookie
 * copied from an authenticated browser session.
 *
 * Uses only Node ≥18 built-ins (global fetch / FormData / Blob) — no extra deps.
 */
import { readFile } from 'fs/promises';
import { basename } from 'path';

export interface LoadConfig {
  /** e.g. https://acme.crmsaudi.dev/api/v1  (NO trailing slash) */
  baseUrl: string;
  /** Full Cookie header, e.g. "sid=abcd1234" */
  cookie: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface ImportPayload {
  fileKey: string;
  mapping: Record<string, string>;
  deduplication?: {
    matchingFields: ('emails' | 'phones')[];
    policy: 'skip' | 'overwrite' | 'merge';
  };
  dryRun?: boolean;
  triggerAutomations?: boolean;
  estimatedRows?: number;
}

export interface ImportSummary {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
}

export interface RunResult {
  jobId: string;
  status: string;
  uploadMs: number;
  importMs: number;
  totalMs: number;
  rows: number;
  throughput: number; // rows / second over importMs
  summary?: ImportSummary;
  preview?: Record<string, number>;
  reportUrl?: string;
  failedReason?: string;
}

export function loadConfigFromEnv(): LoadConfig {
  const baseUrl = (process.env.CRM_BASE_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'CRM_BASE_URL is required, e.g. https://acme.crmsaudi.dev/api/v1',
    );
  }
  const cookie =
    process.env.CRM_COOKIE ??
    (process.env.CRM_SID ? `sid=${process.env.CRM_SID}` : '');
  if (!cookie) {
    throw new Error(
      'Set CRM_COOKIE="sid=..." (or CRM_SID=...) from a logged-in session',
    );
  }
  if (process.env.CRM_INSECURE_TLS === '1') {
    // Allow self-signed certs on staging.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  return {
    baseUrl,
    cookie,
    pollIntervalMs: Number(process.env.CRM_POLL_MS ?? 2000),
    timeoutMs: Number(process.env.CRM_TIMEOUT_MS ?? 30 * 60 * 1000),
  };
}

function headers(cfg: LoadConfig, extra: Record<string, string> = {}) {
  return { Cookie: cfg.cookie, ...extra };
}

async function expectOk(res: Response, label: string) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `${label} failed: HTTP ${res.status} ${body.slice(0, 300)}`,
    );
  }
}

export async function uploadFile(
  cfg: LoadConfig,
  filePath: string,
): Promise<{ fileKey: string; format: string; headers: string[] }> {
  const buf = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), basename(filePath));
  const res = await fetch(`${cfg.baseUrl}/contacts/import-upload`, {
    method: 'POST',
    headers: headers(cfg),
    body: form,
  });
  await expectOk(res, 'upload');
  return res.json() as any;
}

export async function startImport(
  cfg: LoadConfig,
  payload: ImportPayload,
): Promise<{ jobId: string }> {
  const res = await fetch(`${cfg.baseUrl}/contacts/import`, {
    method: 'POST',
    headers: headers(cfg, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  await expectOk(res, 'startImport');
  return res.json() as any;
}

export async function getStatus(cfg: LoadConfig, jobId: string): Promise<any> {
  const res = await fetch(`${cfg.baseUrl}/contacts/import-status/${jobId}`, {
    headers: headers(cfg),
  });
  await expectOk(res, 'getStatus');
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Upload → start → poll to terminal state, capturing timing + summary. */
export async function runImport(
  cfg: LoadConfig,
  args: {
    filePath: string;
    rows: number;
    deduplication?: ImportPayload['deduplication'];
    policy?: 'skip' | 'overwrite' | 'merge';
    dryRun?: boolean;
    mapping: Record<string, string>;
    onTick?: (pct: number | null, processed: number) => void;
  },
): Promise<RunResult> {
  const t0 = Date.now();
  const uploaded = await uploadFile(cfg, args.filePath);
  const uploadMs = Date.now() - t0;

  const tStart = Date.now();
  const { jobId } = await startImport(cfg, {
    fileKey: uploaded.fileKey,
    mapping: args.mapping,
    deduplication: args.deduplication,
    dryRun: args.dryRun,
    estimatedRows: args.rows,
  });

  let status = 'waiting';
  let data: any;
  while (Date.now() - tStart < cfg.timeoutMs) {
    await sleep(cfg.pollIntervalMs);
    data = await getStatus(cfg, jobId);
    status = data.status;
    const p = data.progress;
    if (p && typeof p === 'object')
      args.onTick?.(p.pct ?? null, p.processed ?? 0);
    if (status === 'completed' || status === 'failed') break;
  }

  const importMs = Date.now() - tStart;
  const totalMs = Date.now() - t0;
  const result = data?.result ?? {};
  return {
    jobId,
    status,
    uploadMs,
    importMs,
    totalMs,
    rows: args.rows,
    throughput: importMs > 0 ? Math.round((args.rows / importMs) * 1000) : 0,
    summary: result.summary,
    preview: result.preview,
    reportUrl: result.reportUrl,
    failedReason: data?.failedReason,
  };
}

export function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Pretty-print a single run result + PASS/FAIL against a KPI. */
export function printResult(label: string, r: RunResult, kpiMs?: number) {
  const lines = [
    `\n── ${label} ──`,
    `  jobId       : ${r.jobId}`,
    `  status      : ${r.status}`,
    `  upload      : ${fmtMs(r.uploadMs)}`,
    `  import time : ${fmtMs(r.importMs)}`,
    `  throughput  : ${r.throughput.toLocaleString()} rows/s`,
  ];
  if (r.summary) {
    lines.push(
      `  summary     : total=${r.summary.total} inserted=${r.summary.inserted} ` +
        `updated=${r.summary.updated} skipped=${r.summary.skipped} errors=${r.summary.errors}`,
    );
  }
  if (r.preview) lines.push(`  preview     : ${JSON.stringify(r.preview)}`);
  if (r.reportUrl) lines.push(`  reportUrl   : ${r.reportUrl}`);
  if (r.failedReason) lines.push(`  failedReason: ${r.failedReason}`);
  if (kpiMs != null) {
    const pass = r.status === 'completed' && r.importMs <= kpiMs;
    lines.push(
      `  KPI         : ≤ ${fmtMs(kpiMs)} → ${pass ? 'PASS ✅' : 'FAIL ❌'}`,
    );
  }
  process.stdout.write(lines.join('\n') + '\n');
}
