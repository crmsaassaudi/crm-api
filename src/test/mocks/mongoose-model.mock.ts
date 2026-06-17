/**
 * Standard Mongoose Model mock for unit tests.
 * Returns chainable query objects for find/findOne/etc.
 */
export function createMongooseModelMock(defaults: Record<string, any> = {}) {
  const chainable = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(defaults.findResult ?? null),
  };

  return {
    find: jest.fn().mockReturnValue({
      ...chainable,
      exec: jest.fn().mockResolvedValue(defaults.findResult ?? []),
    }),
    findOne: jest.fn().mockReturnValue(chainable),
    findById: jest.fn().mockReturnValue(chainable),
    create: jest.fn().mockResolvedValue(defaults.createResult ?? {}),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(defaults.count ?? 0),
    }),
    bulkWrite: jest
      .fn()
      .mockResolvedValue({ insertedCount: 0, modifiedCount: 0 }),
    aggregate: jest.fn().mockResolvedValue([]),
  };
}
