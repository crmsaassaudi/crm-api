import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../..');

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['scripts', 'test', 'node_modules'].includes(entry.name)) return [];
      return walk(full);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [full]
      : [];
  });

/**
 * Raw driver access bypasses the tenant Mongoose plugin. Every runtime call
 * must visibly bind tenantId in the operation or carry the reviewed
 * @platform-query marker for an intentionally global collection.
 */
describe('raw Mongo tenant boundary', () => {
  it('requires an explicit tenant predicate near every raw collection operation', () => {
    const violations: string[] = [];
    const operation =
      /(?:\.collection\([^)]*\)|\.collection)\s*\.\s*(find|findOne|aggregate|updateOne|updateMany|deleteOne|deleteMany|bulkWrite)\s*\(/g;

    for (const file of walk(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(operation)) {
        const index = match.index ?? 0;
        const window = source.slice(index, index + 1200);
        if (
          !/\btenantId\b/.test(window) &&
          !/@platform-query/.test(source.slice(Math.max(0, index - 300), index))
        ) {
          const line = source.slice(0, index).split('\n').length;
          violations.push(
            `${path.relative(SRC, file).replaceAll('\\', '/')}:${line} (${match[1]})`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
