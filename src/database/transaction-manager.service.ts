// src/database/transaction-manager.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ClientSession } from 'mongoose';

@Injectable()
export class TransactionManager {
  private readonly logger = new Logger(TransactionManager.name);
  private transactionSupportCheck?: Promise<void>;

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async runInTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    await this.ensureTransactionsSupported();

    const session = await this.connection.startSession();
    try {
      session.startTransaction();
      const result = await work(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      await session.abortTransaction();
      throw error; // Re-throw để phía Service xử lý lỗi nghiệp vụ
    } finally {
      await session.endSession();
    }
  }

  private async ensureTransactionsSupported(): Promise<void> {
    this.transactionSupportCheck ??= this.checkTransactionSupport();
    return this.transactionSupportCheck;
  }

  private async checkTransactionSupport(): Promise<void> {
    const db = this.connection.db;
    if (!db) {
      throw new Error(
        'MongoDB connection is not ready; cannot verify transaction support.',
      );
    }

    const hello = await db.admin().command({ hello: 1 });
    if (hello.setName) {
      return;
    }

    this.logger.error(
      'MongoDB transactions require a replica set. Start MongoDB with --replSet rs0 and use a connection string with ?replicaSet=rs0.',
    );
    throw new Error(
      'MongoDB transactions are not available on standalone MongoDB. Configure a single-node replica set before using TransactionManager.',
    );
  }
}
