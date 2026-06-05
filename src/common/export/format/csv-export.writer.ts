import { once } from 'events';
import { Writable } from 'stream';
import { ExportFormatWriter } from './export-format.interface';

/**
 * Streaming CSV writer (RFC 4180 quoting). Writes directly to the provided
 * Writable (which may be a gzip transform or the storage sink head) and honors
 * backpressure so memory stays flat for arbitrarily large exports.
 */
export class CsvExportWriter implements ExportFormatWriter {
  constructor(private readonly out: Writable) {}

  async writeHeader(headers: string[]): Promise<void> {
    await this.writeRow(headers);
  }

  async writeRow(cells: string[]): Promise<void> {
    const line = cells.map((c) => this.escape(c)).join(',') + '\n';
    if (!this.out.write(line)) {
      await once(this.out, 'drain');
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async finalize(): Promise<void> {
    // End our output stream so the sink's downstream (gzip/upload/file) can
    // flush. The sink awaits a pre-registered completion promise, not us.
    this.out.end();
  }

  private escape(value: string): string {
    return `"${(value ?? '').replace(/"/g, '""')}"`;
  }
}
