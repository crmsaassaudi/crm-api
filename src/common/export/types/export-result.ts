/** Result returned by an export job (also stored on the BullMQ job). */
export interface ExportResult {
  jobId: string;
  recordCount: number;
  downloadUrl: string;
  expiresAt: string;
  storageKey: string;
  format: string;
}

/** Live progress snapshot, mirrored to both BullMQ and the export_jobs doc. */
export interface ExportProgress {
  processed: number;
  total: number | null;
  pct: number | null;
}

/** Raised when an export exceeds its per-format hard row cap. */
export class ExportLimitExceededError extends Error {
  constructor(public readonly cap: number) {
    super(`Export exceeded the maximum of ${cap} rows`);
    this.name = 'ExportLimitExceededError';
  }
}

/** Raised when a running export is cancelled by the user. */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export was cancelled');
    this.name = 'ExportCancelledError';
  }
}

/** Raised when secondary reads are required but the topology has none. */
export class SecondaryUnavailableError extends Error {
  constructor() {
    super(
      'Export requires a MongoDB secondary (EXPORT_REQUIRE_SECONDARY=true) ' +
        'but the current topology has none.',
    );
    this.name = 'SecondaryUnavailableError';
  }
}
