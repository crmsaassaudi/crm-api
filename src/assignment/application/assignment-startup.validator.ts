import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { RecordCandidatePort } from '../adapters/record/record-candidate.port';
import { AssignmentCoreService } from '../core/assignment-core.service';
import { AssignableTypeRegistry } from '../core/assignable-type.registry';

/**
 * Fails application startup when the public assignment vocabulary advertises
 * an object type that has no executable adapter.
 */
@Injectable()
export class AssignmentStartupValidator implements OnApplicationBootstrap {
  private readonly logger = new Logger(AssignmentStartupValidator.name);

  constructor(
    private readonly core: AssignmentCoreService,
    private readonly recordCandidates: RecordCandidatePort,
    private readonly types: AssignableTypeRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const registered = this.types.list();
    const missing = registered
      .filter(({ objectType }) => !this.core.hasAdapter(objectType))
      .map(({ objectType }) => objectType);
    if (missing.length > 0) {
      throw new Error(
        `Assignment startup validation failed: no adapter registered for ${missing.join(', ')}`,
      );
    }
    if (!this.recordCandidates.isPresenceProviderConfigured()) {
      this.logger.warn(
        'Record assignment presence provider is not configured; requireOnline routes will fail closed',
      );
    }
    this.logger.log(
      `Assignment startup validation passed for ${registered.length} object types`,
    );
  }
}
