import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';

let mongod: MongoMemoryServer;
let connection: Connection;

/**
 * Start an in-memory MongoDB instance and return a Mongoose connection.
 * Call once in beforeAll() of your integration test suite.
 */
export async function setupTestDatabase(): Promise<Connection> {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  connection = mongoose.createConnection(uri);
  await connection.asPromise();
  return connection;
}

/**
 * Drop all collections between tests to ensure isolation.
 * Call in afterEach().
 */
export async function clearDatabase(): Promise<void> {
  if (!connection) return;
  const collections = connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

/**
 * Close connection and stop the in-memory MongoDB.
 * Call in afterAll().
 */
export async function teardownTestDatabase(): Promise<void> {
  if (connection) {
    await connection.close();
  }
  if (mongod) {
    await mongod.stop();
  }
}

export { connection };
