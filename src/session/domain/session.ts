import { User } from '../../users/domain/user';

export class Session {
  id: number | string;
  user: User;
  tenantId: string;
  version?: number;
  hash: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}
