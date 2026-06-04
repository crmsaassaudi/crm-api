import { BadRequestException } from '@nestjs/common';
import { CsvImportParser } from './csv-import-parser';
import { XlsxImportParser } from './xlsx-import-parser';
import { IImportParser } from './import-parser.interface';

export type ImportFileFormat = 'csv' | 'xlsx';

export function detectFormat(fileKey: string): ImportFileFormat {
  const lower = fileKey.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  throw new BadRequestException(
    'Unsupported import file type. Only .csv and .xlsx are allowed.',
  );
}

export function createParser(format: ImportFileFormat): IImportParser {
  return format === 'csv' ? new CsvImportParser() : new XlsxImportParser();
}
