import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, unlink } from 'fs/promises';
import { once } from 'events';
import { createInterface } from 'readline';
import { join } from 'path';
import { ContactExportStorageService } from './contact-export-storage.service';

export interface ImportRowError {
  row: number;
  field?: string;
  reason: string;
  value?: string;
}

export interface ImportSummary {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
}

/**
 * Streams per-batch error rows to a temp NDJSON file on disk instead of
 * accumulating them in a RAM array (a 1M-row file with 10% errors would be
 * ~100k objects — enough to OOM the worker). On finalize, the NDJSON is
 * re-streamed into a single JSON report and handed to dual-mode storage.
 */
@Injectable()
export class ContactImportReportService {
  private readonly logger = new Logger(ContactImportReportService.name);

  constructor(private readonly storage: ContactExportStorageService) {}

  createWriter(jobId: string, tenantId: string): ImportReportWriter {
    return new ImportReportWriter(jobId, tenantId, this.storage, this.logger);
  }
}

export class ImportReportWriter {
  private stream: ReturnType<typeof createWriteStream> | null = null;
  private errorCount = 0;
  private readonly ndjsonPath: string;
  private readonly finalPath: string;
  private readonly tmpDir: string;

  constructor(
    private readonly jobId: string,
    private readonly tenantId: string,
    private readonly storage: ContactExportStorageService,
    private readonly logger: Logger,
  ) {
    this.tmpDir = join(process.cwd(), 'files', 'tmp');
    this.ndjsonPath = join(this.tmpDir, `import-report-${jobId}.ndjson`);
    this.finalPath = join(this.tmpDir, `import-report-${jobId}.json`);
  }

  get count(): number {
    return this.errorCount;
  }

  private async ensureStream() {
    if (this.stream) return;
    await mkdir(this.tmpDir, { recursive: true });
    this.stream = createWriteStream(this.ndjsonPath, {
      encoding: 'utf8',
      flags: 'a',
    });
  }

  /** Append a batch of errors. Honors backpressure to keep memory flat. */
  async appendErrors(errors: ImportRowError[]): Promise<void> {
    if (errors.length === 0) return;
    await this.ensureStream();
    const stream = this.stream!;
    for (const err of errors) {
      this.errorCount++;
      if (!stream.write(JSON.stringify(err) + '\n')) {
        await once(stream, 'drain');
      }
    }
  }

  /** Delete temp artifacts without producing a report (dry-run / failure). */
  async discard(): Promise<void> {
    await this.closeStream();
    await this.safeUnlink(this.ndjsonPath);
    await this.safeUnlink(this.finalPath);
  }

  /**
   * Build the final JSON report and persist it. Returns null when there were
   * no errors (nothing worth downloading).
   */
  async finalize(
    summary: ImportSummary,
    ttlSeconds = 24 * 60 * 60,
  ): Promise<{ reportUrl: string; expiresAt: string } | null> {
    await this.closeStream();

    if (this.errorCount === 0) {
      await this.safeUnlink(this.ndjsonPath);
      return null;
    }

    // Stream NDJSON → single JSON array, never loading all errors at once.
    await this.buildFinalJson(summary);

    try {
      const { reportUrl, expiresAt } = await this.storage.storeReportStream(
        createReadStream(this.finalPath, { encoding: 'utf8' }),
        `import-report-${this.jobId}.json`,
        ttlSeconds,
      );
      return { reportUrl, expiresAt };
    } finally {
      await this.safeUnlink(this.ndjsonPath);
      await this.safeUnlink(this.finalPath);
    }
  }

  private async buildFinalJson(summary: ImportSummary): Promise<void> {
    const out = createWriteStream(this.finalPath, { encoding: 'utf8' });
    const write = async (chunk: string) => {
      if (!out.write(chunk)) await once(out, 'drain');
    };

    await write(
      `{"jobId":${JSON.stringify(this.jobId)},` +
        `"tenantId":${JSON.stringify(this.tenantId)},` +
        `"summary":${JSON.stringify(summary)},"errors":[`,
    );

    const input = createReadStream(this.ndjsonPath, { encoding: 'utf8' });
    const rl = createInterface({ input, crlfDelay: Infinity });
    let first = true;
    for await (const line of rl) {
      if (!line.trim()) continue;
      await write(first ? line : ',' + line);
      first = false;
    }

    await write(']}');
    out.end();
    await once(out, 'finish');
  }

  private async closeStream(): Promise<void> {
    if (!this.stream) return;
    const stream = this.stream;
    this.stream = null;
    stream.end();
    await once(stream, 'finish').catch(() => undefined);
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // Already gone — ignore.
    }
  }
}
