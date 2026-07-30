/* eslint-disable */
/**
 * Report exported RUNTIME VALUES with no reference outside their own file.
 *
 * Why this exists: "declared but nothing reads it" has produced real defects here, not just
 * dead weight. Each of these was found by accident, one at a time:
 *
 *   - `onPurge` policies on the account reference registry — declared per collection,
 *     read by nothing, so the column was documentation that looked like behaviour.
 *   - `ACCOUNT_ACTIVITY_TARGET_TYPE` — a constant nobody imported while three call sites
 *     spelled the value out.
 *   - `DEAL_MERGE_REFERENCES` / `TASK_MERGE_REFERENCES` — derived lists with no consumer.
 *   - `wonAt` / `lostAt` — the mirror image: READ by three systems, written by none, so
 *     every deal was permanently "open" to all of them.
 *   - `EXPORT_MAX_RECORDS`, `UNMASK_TTL_SECONDS` — constants named like limits, enforced
 *     nowhere, reading as guarantees the code did not make.
 *   - `status-transition.validator.ts` — an entire state-machine guard, uninstalled, whose
 *     hard-coded status names would have been wrong for any tenant with custom stages.
 *
 * Types and interfaces are deliberately excluded: an exported type used only as a local
 * return annotation is harmless, and there are ~330 of them, which buries the signal.
 *
 * This is a REPORT, not a gate. Triage is the point: for each entry, decide whether it is
 * dead weight or a feature that only looks wired up. Known FALSE POSITIVES, so nobody
 * deletes something live:
 *
 *   1. CROSS-APP STRING CONTRACTS. This scans crm-api/src only. `CHANNEL_SUPPORT_EMPTY_POOL`
 *      looks dead here; crm-web matches it as a literal
 *      (`err.response.data.code === 'CHANNEL_SUPPORT_EMPTY_POOL'`) to offer the
 *      allowEmptyPool retry. Grep crm-web for the VALUE before concluding anything about
 *      an error code.
 *   2. USED ONLY INSIDE ITS OWN FILE. `isTenantHeaderTrusted`, `KmsCryptoService` (built by
 *      `cryptoServiceFactory`), `getRuntimeRole`. These are over-wide exports, not dead
 *      code. Narrowing the export is optional; deleting them breaks the file.
 *   3. SYMMETRIC PREDICATE FAMILIES. `isApiOnlyRuntime` has no caller while its four
 *      siblings do. Deleting one member to satisfy a report leaves a lopsided API.
 *
 * And the reason to RE-RUN after every removal: dead code hides dead code. Deleting
 * `TestEvent` left `BaseEvent` with no subclass, which made the whole `common/events`
 * directory dead — invisible until the first deletion landed.
 *
 *   node src/scripts/check-unused-exports.js
 *   node src/scripts/check-unused-exports.js --spec-only
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Exports these frameworks consume by decorator or convention rather than by import.
const FRAMEWORK_OWNED =
  /(\.dto|\.schema|\.module|\.controller|\.processor|\.guard|\.interceptor|\.filter|\.decorator|\.strategy|\.gateway|\.listener)\.ts$|^(main|app)\.|\/(scripts|migrations|seeds)\//;

const VALUE_RE =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(const|function|class|enum)\s+([A-Za-z_$][\w$]*)/gm;

const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');

function main() {
  const all = walk(SRC).map((file) => [file, fs.readFileSync(file, 'utf8')]);
  const noReference = [];
  const specOnly = [];

  for (const [file, source] of all) {
    if (file.endsWith('.spec.ts')) continue;
    if (FRAMEWORK_OWNED.test(rel(file))) continue;

    VALUE_RE.lastIndex = 0;
    let match;
    while ((match = VALUE_RE.exec(source)) !== null) {
      const [, kind, name] = match;
      const word = new RegExp('\\b' + name + '\\b');
      let external = 0;
      let onlySpecs = true;
      for (const [other, text] of all) {
        if (other === file) continue;
        if (word.test(text)) {
          external++;
          if (!other.endsWith('.spec.ts')) onlySpecs = false;
        }
      }
      const row = { file: rel(file), name, kind };
      if (external === 0) noReference.push(row);
      else if (onlySpecs) specOnly.push(row);
    }
  }

  const report = (label, rows) => {
    console.log('\n## ' + label + ': ' + rows.length);
    for (const row of rows) {
      console.log(
        '  ' + row.kind.padEnd(9) + row.name.padEnd(38) + row.file,
      );
    }
  };

  report('exported value, no reference anywhere', noReference);
  if (process.argv.includes('--spec-only')) {
    report('exported value, referenced only by its own tests', specOnly);
  } else {
    console.log(
      '\n(' +
        specOnly.length +
        ' more are referenced only by their own tests — pass --spec-only to list them.)',
    );
  }
}

main();
