// ── Types ──
export * from './types';

// ── Parsers ──
export { IImportParser } from './import-parser.interface';
export { CsvImportParser } from './csv-import-parser';
export { XlsxImportParser } from './xlsx-import-parser';
export { detectFormat, createParser } from './import-parser.factory';
export type { ImportFileFormat } from './import-parser.factory';

// ── Services ──
export {
  ImportStorageService,
  ImportStorageFactory,
} from './import-storage.service';
export {
  ImportReportService,
  ImportReportWriter,
} from './import-report.service';
export { ImportProgressTracker } from './import-progress.service';
export {
  ImportDedupEngine,
  type DedupConfig,
  type DedupMatch,
} from './import-dedup.service';
export {
  ImportReferenceResolver,
  type ResolvedReference,
  type RowReferenceResult,
} from './import-reference-resolver.service';

// ── Base Processor ──
export { BaseImportProcessor } from './base-import.processor';

// ── Schema ──
export {
  ImportJobSchemaClass,
  ImportJobSchema,
  type ImportJobDocument,
} from './import-job.schema';

// ── Module ──
export { SharedImportModule } from './import.module';
