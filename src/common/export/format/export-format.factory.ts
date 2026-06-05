import { Writable } from 'stream';
import { ExportFormat } from '../types';
import { ExportFormatWriter } from './export-format.interface';
import { CsvExportWriter } from './csv-export.writer';
import { XlsxExportWriter } from './xlsx-export.writer';

/** Build a streaming writer for the requested format, targeting `out`. */
export function createExportWriter(
  format: ExportFormat,
  out: Writable,
): ExportFormatWriter {
  switch (format) {
    case 'csv':
      return new CsvExportWriter(out);
    case 'xlsx':
      return new XlsxExportWriter(out);
    default:
      throw new Error(`Unsupported export format: ${String(format)}`);
  }
}
