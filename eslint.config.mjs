import tsEslintPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import commentHygiene from './eslint-rules/comment-hygiene.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  {
    // Standalone operator scripts: plain CommonJS `.js`, deliberately outside
    // tsconfig.json (they are run with `node`, never compiled). The type-aware parser
    // cannot read a file the project does not include, so linting them produced three
    // permanent parsing errors — noise that trains everyone to ignore lint output.
    ignores: ['src/scripts/**/*.js', 'eslint-rules/**'],
  },
  ...compat.extends(
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ),
  {
    plugins: {
      '@typescript-eslint': tsEslintPlugin,
      'comment-hygiene': commentHygiene,
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      parser: tsParser,
      ecmaVersion: 5,
      sourceType: 'module',
      parserOptions: {
        project: 'tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'require-await': 'off',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.object.name=configService][callee.property.name=/^(get|getOrThrow)$/]:not(:has([arguments.1] Property[key.name=infer][value.value=true])), CallExpression[callee.object.property.name=configService][callee.property.name=/^(get|getOrThrow)$/]:not(:has([arguments.1] Property[key.name=infer][value.value=true]))',
          message:
            'Add "{ infer: true }" to configService.get() for correct typechecking. Example: configService.get("database.port", { infer: true })',
        },
        {
          selector:
            'CallExpression[callee.name=it][arguments.0.value!=/^should/]',
          message: '"it" should start with "should"',
        },
        {
          // Catch unbounded Mongo bulk operations. Every updateMany/deleteMany
          // MUST run inside a function or have an explicit safety filter —
          // tenantFilterPlugin will inject tenantId at runtime, but lint
          // helps spot the pattern at review time.
          selector:
            "CallExpression[callee.property.name=/^(updateMany|deleteMany)$/][arguments.0.type=ObjectExpression][arguments.0.properties.length=0]",
          message:
            'Refusing updateMany/deleteMany with an empty filter. Add at least a tenantId or business key to the filter.',
        },
      ],

      // Comment hygiene. These three are mechanical — there is no case where a
      // decorative rule, an unresolvable tracker id or a commented-out
      // statement is the right answer, so they fail the build.
      'comment-hygiene/no-box-separator': 'error',
      'comment-hygiene/no-tracker-tag': 'error',
      'comment-hygiene/no-commented-out-code': 'error',

      // These two need a human to agree. A long comment is sometimes exactly
      // right (a port contract, a threat model), and "used to" occasionally
      // means "is employed to" — so they warn rather than block.
      'comment-hygiene/max-comment-block-lines': [
        'warn',
        { max: 12, maxFileHeader: 20 },
      ],
      'comment-hygiene/no-history-narration': 'warn',
    },
  },
];
