import { AppConfig } from './app-config.type';
import { AuthConfig } from '../auth/config/auth-config.type';
import { DatabaseConfig } from '../database/config/database-config.type';
import { FileConfig } from '../files/config/file-config.type';
import { MailConfig } from '../mail/config/mail-config.type';
import { QueueConfig } from '../queue/config/queue-config.type';
import { RedisConfig } from '../redis/config/redis-config.type';
import { KeycloakConfig } from '../auth/config/keycloak-config.type';

export type AllConfigType = {
  app: AppConfig;
  auth: AuthConfig;
  database: DatabaseConfig;
  file: FileConfig;
  mail: MailConfig;
  queue: QueueConfig;
  redis: RedisConfig;
  keycloak: KeycloakConfig;
};
