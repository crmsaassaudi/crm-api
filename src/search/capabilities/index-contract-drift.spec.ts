import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INDEXED_FILTER_FIELDS } from '../engines/opensearch-filter';
import { SEARCH_MODULES } from '../dto/global-search-query.dto';

/**
 * The one guard against the defect that has produced every parity bug in this
 * subsystem so far.
 *
 * `crm-opensearch` does not depend on `crm-api`. It reads MongoDB with the raw
 * driver and re-declares, in its own source, what a searchable record is, what
 * "deleted" means, which modules exist and which fields are indexed. The only
 * thing joining the two copies is a comment saying "keep in step" — and a
 * comment has never failed a build.
 *
 * What that produced, in order: a mapper reading `row.email`/`row.phone`, two
 * fields that never existed, so account e-mail and phone were silently absent
 * from the index; archived accounts staying searchable; an empty `ownerId`
 * meaning "unowned" on one side and "owned" on the other. Four bugs, one cause.
 *
 * The check that matters most is the first one below. A field crm-api believes
 * it may filter on, but which the index does not have, is not a cosmetic
 * mismatch: a DENY policy compiles to `must_not`, and a `must_not` over an
 * unmapped field matches every document — so the drift turns a deny rule into
 * an allow rule.
 *
 * Limitation, stated rather than hidden: the two repositories are checked out
 * separately in their own CI, so this can only run where both are present. It
 * protects every developer working tree and the combined checkout. The durable
 * fix is a shared package (or folding the indexer into crm-api as a fourth
 * worker); see docs/audit/SEARCH_CONVERGENCE_2026-08-01.md.
 */
const INDEXER_ROOT = join(__dirname, '..', '..', '..', '..', 'crm-opensearch');
const INDEX_DEFINITION = join(
  INDEXER_ROOT,
  'src',
  'index',
  'index-definition.ts',
);
const SEARCH_DOCUMENT = join(
  INDEXER_ROOT,
  'src',
  'contracts',
  'search-document.ts',
);

const sourceOf = (file: string): string => readFileSync(file, 'utf8');

/** Extracts the string literals of an exported `const NAME = [...]` array. */
const exportedStringArray = (source: string, name: string): string[] => {
  const match = new RegExp(
    `export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`,
  ).exec(source);
  if (!match) {
    throw new Error(
      `Could not find "export const ${name} = [...] as const" in the indexer source. ` +
        `If it was renamed or reshaped, update this guard in the same commit — do not delete it.`,
    );
  }
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
};

const bothRepositoriesPresent = existsSync(INDEX_DEFINITION);

(bothRepositoriesPresent ? describe : describe.skip)(
  'search index contract (crm-api ↔ crm-opensearch)',
  () => {
    const definitionSource = bothRepositoriesPresent
      ? sourceOf(INDEX_DEFINITION)
      : '';
    const documentSource = bothRepositoriesPresent
      ? sourceOf(SEARCH_DOCUMENT)
      : '';

    it('should never let crm-api filter on a field the index does not have', () => {
      const indexedFields = exportedStringArray(
        definitionSource,
        'INDEXED_FIELDS',
      );
      const missing = [...INDEXED_FILTER_FIELDS].filter(
        (field) => !indexedFields.includes(field),
      );
      expect({ missing, indexedFields }).toEqual({
        missing: [],
        indexedFields: expect.any(Array),
      });
    });

    it('should keep every mapped field actually present in the mapping block', () => {
      const indexedFields = exportedStringArray(
        definitionSource,
        'INDEXED_FIELDS',
      );
      const mappingBlock = definitionSource.slice(
        definitionSource.indexOf('properties: {'),
      );
      const unmapped = indexedFields.filter(
        (field) => !new RegExp(`\\b${field}:\\s*\\{`).test(mappingBlock),
      );
      expect(unmapped).toEqual([]);
    });

    it('should agree with the indexer about which modules exist', () => {
      const indexerModules = exportedStringArray(
        documentSource,
        'SEARCH_MODULES',
      );
      expect([...indexerModules].sort()).toEqual([...SEARCH_MODULES].sort());
    });

    it('should keep search-only fields out of the authorization allowlist', () => {
      // These exist to make records findable, not to decide who may see them.
      // A relevance field used as a security predicate is the fail-open shape
      // the allowlist exists to prevent.
      const searchOnly = [
        'title',
        'subtitle',
        'searchText',
        'phoneSuffixes',
        'contentHash',
        'customFields',
      ];
      const leaked = searchOnly.filter((field) =>
        INDEXED_FILTER_FIELDS.has(field),
      );
      expect(leaked).toEqual([]);
    });

    it('should mirror every hidden-state flag the query side relies on', () => {
      // The query always excludes `flags: archived`. If the indexer stops
      // producing that flag, the exclusion silently matches nothing and hidden
      // records come back — the exact failure this pair of files caused before.
      const mapperSource = sourceOf(
        join(INDEXER_ROOT, 'src', 'normalization', 'document-mapper.ts'),
      );
      expect(mapperSource).toContain('"archived"');
      expect(exportedStringArray(definitionSource, 'INDEXED_FIELDS')).toContain(
        'flags',
      );
    });
  },
);
