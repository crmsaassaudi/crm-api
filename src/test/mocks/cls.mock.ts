/**
 * Standard ClsService mock for unit tests.
 * CLS (Continuation Local Storage) holds request-scoped context like tenantId, userId.
 */
export function createClsMock(
  overrides: Record<string, any> = {},
) {
  const store: Record<string, any> = {
    tenantId: 'tenant_1',
    activeTenantId: 'tenant_1',
    userId: 'user_1',
    'user.id': 'user_1',
    email: 'test@example.com',
    ...overrides,
  };

  return {
    get: jest.fn((key: string) => store[key]),
    set: jest.fn((key: string, value: any) => {
      store[key] = value;
    }),
    has: jest.fn((key: string) => key in store),
    getId: jest.fn().mockReturnValue('cls-id'),
    run: jest.fn((fn: () => any) => fn()),
    runWith: jest.fn((store: any, fn: () => any) => fn()),
  };
}
