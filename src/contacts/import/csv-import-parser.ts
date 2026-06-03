import { Readable } from 'stream';
import csv from 'csv-parser';
import { IImportParser } from './import-parser.interface';

/**
 * True-streaming CSV parser built on `csv-parser`. Each chunk is parsed
 * incrementally; rows are emitted one at a time and never accumulated, so the
 * resident set stays flat regardless of file size.
 */
export class CsvImportParser implements IImportParser {
  async *parse(stream: Readable): AsyncIterable<Record<string, string>> {
    const parser = stream.pipe(
      csv({
        // Trim BOM + surrounding whitespace from header cells so the mapping
        // keys produced here match what readHeaders() surfaced to the client.
        mapHeaders: ({ header }) => header.replace(/^﻿/, '').trim(),
        mapValues: ({ value }) =>
          typeof value === 'string' ? value.trim() : value,
      }),
    );

    try {
      for await (const row of parser) {
        yield row as Record<string, string>;
      }
    } finally {
      // Ensure the underlying file/network stream is released even on early
      // break or downstream error (prevents fd / socket leaks).
      stream.destroy();
    }
  }

  readHeaders(stream: Readable): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const parser = stream.pipe(
        csv({
          mapHeaders: ({ header }) => header.replace(/^﻿/, '').trim(),
        }),
      );

      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        fn();
      };

      parser.on('headers', (headers: string[]) =>
        finish(() => resolve(headers)),
      );
      parser.on('end', () => finish(() => resolve([])));
      parser.on('error', (err) => finish(() => reject(err)));
      // csv-parser never flushes (no `end`/`headers`) for a completely empty
      // input, so fall back to the source stream's own `end`/`close`.
      stream.on('end', () => finish(() => resolve([])));
      stream.on('close', () => finish(() => resolve([])));
      stream.on('error', (err) => finish(() => reject(err)));
    });
  }
}
