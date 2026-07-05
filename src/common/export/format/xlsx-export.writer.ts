import * as ExcelJS from 'exceljs';
import { Writable } from 'stream';
import { ExportFormatWriter } from './export-format.interface';
import { sanitizeCellValue } from './sanitize-cell';

// Excel hard limit is 1,048,576 rows per sheet (incl. header). Roll a little
// before that so we never trip the limit. Configurable for testing.
const ROWS_PER_SHEET = Number(
  process.env.EXPORT_XLSX_ROWS_PER_SHEET ?? 1_000_000,
);

/**
 * Streaming XLSX writer built on ExcelJS's `WorkbookWriter`, which commits rows
 * to the underlying stream incrementally so memory stays bounded.
 *
 * Rolls over to a new worksheet ("Export 1", "Export 2", …) when the current
 * sheet approaches Excel's per-sheet row limit, re-emitting the header on each
 * new sheet. This lets a single .xlsx hold arbitrarily many rows.
 */
export class XlsxExportWriter implements ExportFormatWriter {
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private sheet: ExcelJS.Worksheet;
  private headers: string[] = [];
  private rowsInSheet = 0;
  private sheetIndex = 1;

  constructor(out: Writable) {
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: out,
      useStyles: false,
      useSharedStrings: false,
    });
    this.sheet = this.workbook.addWorksheet('Export 1');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async writeHeader(headers: string[]): Promise<void> {
    this.headers = headers;
    this.sheet.addRow(headers).commit();
    this.rowsInSheet = 1;
  }

  async writeRow(cells: string[]): Promise<void> {
    if (this.rowsInSheet >= ROWS_PER_SHEET) {
      await this.rollover();
    }
    // HIGH-03: Neutralize formula injection (=, +, -, @, tab, CR)
    const safeCells = cells.map((c) => sanitizeCellValue(c));
    this.sheet.addRow(safeCells).commit();
    this.rowsInSheet++;
  }

  async finalize(): Promise<void> {
    // Commits the active worksheet then finalizes the zip and ends the stream.
    this.sheet.commit();
    await this.workbook.commit();
  }

  private rollover(): void {
    this.sheet.commit();
    this.sheetIndex++;
    this.sheet = this.workbook.addWorksheet(`Export ${this.sheetIndex}`);
    if (this.headers.length) {
      this.sheet.addRow(this.headers).commit();
    }
    this.rowsInSheet = this.headers.length ? 1 : 0;
  }
}
