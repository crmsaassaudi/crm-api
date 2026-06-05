import { ExportColumn, ExportFormat } from './export-context';

/**
 * Central contract defining how a module's export should behave.
 *
 * Each module provides ONE static config that drives the shared engine
 * (BaseExportProcessor): which columns exist, hard caps per format, throttle,
 * masking resource, queue + completion channel.
 */
export interface ExportModuleConfig {
  /** Module identifier — used in lock keys, Redis channels, storage prefixes. */
  module: string;

  /** Display name for UI/logging. */
  displayName: string;

  /**
   * Resource name used to look up masking layout config (e.g. 'Contact').
   * Mirrors the `@MaskedResource()` value used by DataMaskingInterceptor.
   */
  maskingResource: string;

  /** All exportable columns, in default output order. */
  columns: readonly ExportColumn[];

  /**
   * Whitelist of column `path`s a caller may select. Anything outside this set
   * is rejected to prevent arbitrary field exfiltration.
   */
  selectableColumns: ReadonlySet<string>;

  /** Cursor batch size (docs pulled per round-trip). Default 1000. */
  batchSize: number;

  /** Hard row cap per format — the engine rejects exports that exceed it. */
  hardCap: Record<ExportFormat, number>;

  /** ms to pause between batches, sparing MongoDB CPU. Default 50. */
  throttleMs: number;

  /** Gzip the CSV output (XLSX is never gzipped — it is already a zip). */
  gzipCsv: boolean;

  /** Redis pub/sub channel for completion events. */
  completionChannel: string;

  /** BullMQ queue name. */
  queueName: string;
}
