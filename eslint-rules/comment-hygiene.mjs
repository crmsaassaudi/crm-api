/**
 * Local ESLint rules that keep comment noise from creeping back in.
 *
 * Core ESLint selectors never see comments, so each rule below walks
 * `sourceCode.getAllComments()` on Program:exit instead.
 *
 * What these rules deliberately do NOT police: how long a *useful* comment is,
 * or whether a file has "enough" comments. A comment that states an invariant,
 * a fail-closed decision or a contract the types cannot express is the point of
 * commenting — the rules here only target decoration, unresolvable tracker ids,
 * dead code and post-mortem narration.
 */

const BOX = /[─-╿]{3,}/;
const ASCII_RULE = /(?:^|\s)([=\-*_~#])\1{5,}/;

// An id only a tracker can resolve. `P0:` / `P1:` are deliberately absent —
// several files use them for a documented tier ordering defined in the same
// file, which is a local taxonomy a reader CAN resolve. `P0 fix` is caught,
// because "fix" is what makes it a finding reference.
const TRACKER = new RegExp(
  '^\\s*(?:' +
    '(?:MED|HIGH|LOW|CRIT|SEC|REL|OPS|PERF|DATA|ARCH|OBS|MAINT|REALTIME|BUG|FINDING|ISSUE)-?\\d+[a-z]?' +
    '|[CHMLT]-?\\d{1,3}[a-z]?' +
    '|FIX' +
    '|[A-Z]\\d+[a-z]?\\s+fix' +
    '|(?:Phase|Sprint|Task|Pillar)\\s*\\d+(?:\\.\\d+)?' +
    ')\\s*(?::|\\)|\\]|—|\\s*$)',
);

// A commented-out statement, as opposed to prose that happens to open with a
// keyword ("let mongoose handle it", "import modules, etc.").
//
// Two guards keep this honest. Only `//` comments are considered — block
// comments are where JSDoc keeps its `@example` payload shapes, and those are
// documentation. And the line must also END like code (`;` `{` `}` `,` `(` `)`),
// because an English sentence ends on a word or a full stop.
const DEAD_CODE_START = [
  /^\s*(?:const|let|var)\s+[\w{[$][\w\s,{}[\]$:]*=/,
  /^\s*(?:await|return)\s+[\w[({$]/,
  /^\s*(?:if|for|while|switch|catch)\s*\(/,
  /^\s*(?:await\s+)?this\.[\w$]+\s*\(/,
  /^\s*import\s+(?:[\w{*][^;]*\bfrom\b|['"])/,
  /^\s*export\s+(?:const|default|class|function|\{)/,
];
const DEAD_CODE_END = /[;{},()]$/;
const LONE_BRACE = /^\s*[})\]]+\s*(?:;|,|\)|else|catch|finally)?\s*$/;

function looksLikeCode(text) {
  const t = text.trim();
  if (!t) return false;
  if (LONE_BRACE.test(t)) return true;
  return DEAD_CODE_START.some((re) => re.test(t)) && DEAD_CODE_END.test(t);
}

const NARRATION =
  /\b(?:it |this |that )?used to (?:be|do|live|carry|collect|return|report|persist|skip|subscribe|accept|point|read|set)\b|\bthe old code\b|\bbefore this fix\b|\bwe used to\b|\bthe previous (?:behavior|behaviour|implementation|version)\b/i;

/** Comment text without the leading `//`, `/*`, or per-line `*`. */
function textOf(comment) {
  return comment.type === 'Line'
    ? comment.value
    : comment.value
        .split('\n')
        .map((l) => l.replace(/^\s*\*?/, ''))
        .join('\n');
}

/** Every physical line of a comment, so a rule can report the offending one. */
function linesOf(comment) {
  const raw = comment.value.split('\n');
  return raw.map((l, i) => ({
    text: comment.type === 'Line' ? l : l.replace(/^\s*\*?\s?/, ''),
    line: comment.loc.start.line + i,
  }));
}

const noBoxSeparator = {
  meta: {
    type: 'suggestion',
    fixable: 'whitespace',
    docs: {
      description:
        'Ban decorative rules in comments. A section banner is a sign the file wants splitting, not a mustache.',
    },
    schema: [],
    messages: {
      decoration:
        'Decorative separator in a comment. Use a plain `// Title`, or split the file if it needs a table of contents.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      'Program:exit'() {
        for (const comment of sourceCode.getAllComments()) {
          const all = linesOf(comment);
          for (let i = 0; i < all.length; i++) {
            const { text, line } = all[i];
            if (!BOX.test(text) && !ASCII_RULE.test(text)) continue;
            // A diagram (arrows, pipes forming a graph) is content, not decoration.
            if (/[▶►→←↔│┌└├]/.test(text)) continue;
            // A Markdown setext underline under a heading line is structure.
            const prev = (all[i - 1]?.text ?? '').trim();
            if (/^[=-]+$/.test(text.trim()) && prev && !/^[=-]+$/.test(prev)) {
              continue;
            }
            context.report({
              loc: { start: { line, column: 0 }, end: { line, column: 1 } },
              messageId: 'decoration',
            });
          }
        }
      },
    };
  },
};

const noTrackerTag = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Ban audit/sprint tracker ids in comments. A reader of the code cannot resolve "MED-07"; say what the rule is instead.',
    },
    schema: [],
    messages: {
      tracker:
        'Tracker id "{{tag}}" in a comment. A reader cannot resolve it — state the rule or the reason instead, and leave the id in the commit message.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      'Program:exit'() {
        for (const comment of sourceCode.getAllComments()) {
          for (const { text, line } of linesOf(comment)) {
            const m = TRACKER.exec(text);
            if (!m) continue;
            context.report({
              loc: { start: { line, column: 0 }, end: { line, column: 1 } },
              messageId: 'tracker',
              data: { tag: m[0].trim() },
            });
          }
        }
      },
    };
  },
};

const noCommentedOutCode = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban commented-out code. Git remembers it; a reader cannot tell whether it is a plan, a rollback or an accident.',
    },
    schema: [],
    messages: {
      deadCode:
        'Commented-out code. Delete it — git has the history — or, if it documents intent, write the intent as a sentence.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      'Program:exit'() {
        // An operator runbook (`db.foo.createIndex(...)` spelled out over
        // several lines) is documentation. Once a run of adjacent `//` lines
        // opens with a command, the rest of that run is its continuation.
        let runbookUntilLine = -1;
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type !== 'Line') continue;
          const startLine = comment.loc.start.line;
          const adjacent = startLine === runbookUntilLine + 1;
          for (const { text, line } of linesOf(comment)) {
            if (/^\s*(?:db\.|npm |npx |curl |mongosh|kubectl |docker )/.test(text)) {
              runbookUntilLine = line;
              continue;
            }
            if (adjacent) {
              runbookUntilLine = line;
              continue;
            }
            if (!looksLikeCode(text)) continue;
            context.report({
              loc: { start: { line, column: 0 }, end: { line, column: 1 } },
              messageId: 'deadCode',
            });
          }
        }
      },
    };
  },
};

const maxCommentBlockLines = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Cap how long one comment may run. Past the cap the explanation belongs in docs/, with the comment pointing at it.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          max: { type: 'integer', minimum: 3 },
          maxFileHeader: { type: 'integer', minimum: 3 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      tooLong:
        'Comment runs {{actual}} lines (limit {{max}}). Keep the invariant here and move the essay to docs/, or split what it describes.',
    },
  },
  create(context) {
    const { max = 12, maxFileHeader = 20 } = context.options[0] ?? {};
    const sourceCode = context.sourceCode;
    return {
      'Program:exit'() {
        const comments = sourceCode.getAllComments();
        // Consecutive `//` lines read as one comment to a human, so measure runs.
        let run = null;
        const flush = () => {
          if (!run) return;
          const isHeader = run.startLine <= 3;
          const limit = isHeader ? maxFileHeader : max;
          if (run.count > limit) {
            context.report({
              loc: {
                start: { line: run.startLine, column: 0 },
                end: { line: run.startLine, column: 1 },
              },
              messageId: 'tooLong',
              data: { actual: run.count, max: limit },
            });
          }
          run = null;
        };
        for (const c of comments) {
          const startLine = c.loc.start.line;
          const count =
            c.type === 'Line' ? 1 : c.loc.end.line - c.loc.start.line + 1;
          if (run && c.type === 'Line' && startLine === run.endLine + 1) {
            run.count += 1;
            run.endLine = startLine;
            continue;
          }
          flush();
          run = { startLine, endLine: c.loc.end.line, count };
        }
        flush();
      },
    };
  },
};

const noHistoryNarration = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Discourage post-mortems in comments. State the rule the code follows now; the story of the bug belongs in the commit.',
    },
    schema: [],
    messages: {
      narration:
        'Comment narrates what the code "used to" do. State the invariant in the present tense — git holds the history.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      'Program:exit'() {
        for (const comment of sourceCode.getAllComments()) {
          const text = textOf(comment);
          const m = NARRATION.exec(text);
          if (!m) continue;
          context.report({
            loc: {
              start: { line: comment.loc.start.line, column: 0 },
              end: { line: comment.loc.start.line, column: 1 },
            },
            messageId: 'narration',
          });
        }
      },
    };
  },
};

export default {
  rules: {
    'no-box-separator': noBoxSeparator,
    'no-tracker-tag': noTrackerTag,
    'no-commented-out-code': noCommentedOutCode,
    'max-comment-block-lines': maxCommentBlockLines,
    'no-history-narration': noHistoryNarration,
  },
};
