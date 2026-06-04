import { Readable } from 'stream';
import * as ExcelJS from 'exceljs';
import { IImportParser } from './import-parser.interface';

/**
 * Streaming XLSX parser using ExcelJS's `WorkbookReader`. Unlike SheetJS
 * community edition, ExcelJS exposes a real row-by-row streaming API, so a
 * large sheet never has to be fully decompressed into memory at once.
 *
 * Only the first worksheet is processed; the first row is treated as headers.
 */
export class XlsxImportParser implements IImportParser {
  private cellToString(value: ExcelJS.CellValue): string {
    if (value == null) return '';
    if (typeof value === 'object') {
      // Rich text, hyperlink, formula result, and date objects.
      const v = value as any;
      if (v instanceof Date) return v.toISOString();
      if (typeof v.text === 'string') return v.text;
      if (v.result != null) return String(v.result);
      if (Array.isArray(v.richText)) {
        return v.richText.map((rt: any) => rt.text).join('');
      }
      if (typeof v.hyperlink === 'string') return v.hyperlink;
    }
    return String(value).trim();
  }

  /** Convert ExcelJS's 1-based sparse `row.values` array to header cells. */
  private rowCells(row: ExcelJS.Row): string[] {
    const values = row.values as ExcelJS.CellValue[];
    const cells: string[] = [];
    // Index 0 is always undefined in ExcelJS; columns are 1-based.
    for (let col = 1; col < values.length; col++) {
      cells[col - 1] = this.cellToString(values[col]);
    }
    return cells;
  }

  async *parse(stream: Readable): AsyncIterable<Record<string, string>> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(stream, {});
    try {
      let headers: string[] | null = null;
      for await (const worksheet of workbook) {
        for await (const row of worksheet) {
          const cells = this.rowCells(row);
          if (!headers) {
            headers = cells.map((c) => (c ?? '').trim());
            continue;
          }
          const record: Record<string, string> = {};
          headers.forEach((header, idx) => {
            if (header) record[header] = cells[idx] ?? '';
          });
          yield record;
        }
        // Only the first worksheet carries data.
        break;
      }
    } finally {
      stream.destroy();
    }
  }

  async readHeaders(stream: Readable): Promise<string[]> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(stream, {});
    try {
      for await (const worksheet of workbook) {
        for await (const row of worksheet) {
          return this.rowCells(row).map((c) => (c ?? '').trim());
        }
      }
      return [];
    } finally {
      stream.destroy();
    }
  }
}
