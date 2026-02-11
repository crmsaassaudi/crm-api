// src/database/transaction-manager.service.ts
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ClientSession } from 'mongoose';

@Injectable()
export class TransactionManager {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async runInTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    session.startTransaction();
    try {
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
}
