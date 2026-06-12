/**
 * Standard EventEmitter2 mock for unit tests.
 * Use expect.objectContaining() for event payload assertions
 * to avoid coupling to internal payload shapes.
 */
export function createEventBusMock() {
  return {
    emit: jest.fn(),
    emitAsync: jest.fn().mockResolvedValue([]),
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
  };
}
