/**
 * A streaming, backpressure-aware writer for one export file.
 *
 * The engine calls `writeHeader` once, then `writeRow` per record (awaiting the
 * returned promise so backpressure is honored), then `finalize` once.
 */
export interface ExportFormatWriter {
  writeHeader(headers: string[]): Promise<void>;
  /** Render + write one row. Awaiting this drains the underlying stream. */
  writeRow(cells: string[]): Promise<void>;
  /** Flush any buffered content. Does NOT close the sink (engine owns that). */
  finalize(): Promise<void>;
}
