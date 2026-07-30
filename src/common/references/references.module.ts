import { Global, Module } from '@nestjs/common';
import { RetentionPurgeRunner } from './retention-purge.runner';

/**
 * The shared retention-purge loop.
 *
 * `@Global` for the same reason the Redis and audit modules are: five domains need the
 * runner, it holds no per-domain state, and threading an import through five feature
 * modules to hand each one the same stateless helper is noise. The runner takes only the
 * Mongoose connection, which `MongooseCoreModule` already publishes globally — so no
 * Mongoose import is needed here. (An earlier version added
 * `MongooseModule.forFeature([])` to "make the connection resolvable"; it is not needed,
 * and an isolated DI test that omitted `forRoot` was what made it look necessary.)
 */
@Global()
@Module({
  providers: [RetentionPurgeRunner],
  exports: [RetentionPurgeRunner],
})
export class ReferencesModule {}
