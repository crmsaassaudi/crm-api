/**
 * Query-side integration suite for global search. Requires the throwaway stack
 * from crm-opensearch and the index its integration suite builds:
 *
 *   cd crm-opensearch && npm run test:it:up && npm run test:it
 *   cd crm-api && npm run test:search:it
 */
module.exports = {
  rootDir: 'src',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testMatch: ['**/*.int-spec.ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }],
  },
  testTimeout: 120000,
  maxWorkers: 1,
};
