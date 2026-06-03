import { Readable } from 'stream';

/**
 * Pluggable parser contract so CSV / XLSX (or future formats) can be swapped
 * without touching the import core. Implementations MUST stream — never buffer
 * the whole file into memory — to stay OOM-safe on 1M+ row files.
 */
export interface IImportParser {
  /**
   * Stream the data rows as objects keyed by the file's header columns.
   * One yielded item == one source row (header row excluded).
   */
  parse(stream: Readable): AsyncIterable<Record<string, string>>;

  /**
   * Read only the header row (column names) without consuming the data rows.
   * Used by the upload endpoint to preview columns for field mapping.
   */
  readHeaders(stream: Readable): Promise<string[]>;
}
