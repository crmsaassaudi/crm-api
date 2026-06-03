import { Readable } from 'stream';
import { CsvImportParser } from './csv-import-parser';

function streamOf(text: string): Readable {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

describe('CsvImportParser', () => {
  const parser = new CsvImportParser();

  it('reads header row', async () => {
    const headers = await parser.readHeaders(
      streamOf('First Name,Last Name,Email\nAlice,Smith,a@x.com\n'),
    );
    expect(headers).toEqual(['First Name', 'Last Name', 'Email']);
  });

  it('strips a UTF-8 BOM from the first header', async () => {
    const headers = await parser.readHeaders(
      streamOf('﻿First Name,Last Name\nAlice,Smith\n'),
    );
    expect(headers[0]).toBe('First Name');
  });

  it('returns [] for an empty file', async () => {
    expect(await parser.readHeaders(streamOf(''))).toEqual([]);
  });

  it('streams data rows keyed by header', async () => {
    const rows: Record<string, string>[] = [];
    for await (const row of parser.parse(streamOf('a,b\n1,2\n3,4\n'))) {
      rows.push(row);
    }
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('trims surrounding whitespace from values', async () => {
    const rows: Record<string, string>[] = [];
    for await (const row of parser.parse(streamOf('name\n  Bob  \n'))) {
      rows.push(row);
    }
    expect(rows[0].name).toBe('Bob');
  });
});
