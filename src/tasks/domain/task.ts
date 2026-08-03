import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority, TaskRecurrenceRule } from '../tasks.constants';

/**
 * A task as the rest of the application sees it.
 *
 * The field list here is load-bearing, not documentation: `TaskMapper` is the
 * only way data reaches the collection, and `BaseDocumentRepository.update`
 * builds its `$set` from whatever `toPersistence()` produces. So a field the
 * mapper does not know about cannot be updated, no matter what the schema and
 * the DTO say. That is how `orgUnitId`, every recurrence field and `updatedById`
 * came to be silently unwritable on PATCH — the schema declared them, the DTO
 * would have accepted them, and the mapper dropped them on the floor.
 * `domain-schema-parity` in the authz suite now asserts this list stays in step
 * with the schema.
 */
export class Task {
  @ApiProperty({ example: '60d0fe4f5311236168a109cf' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenantId: string;

  @ApiProperty({ example: 'Follow up with new lead' })
  title: string;

  @ApiPropertyOptional({ example: 'Call John Doe regarding his interest' })
  description?: string;

  @ApiProperty({ example: '2026-03-15T10:00:00Z' })
  dueDate: Date;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cf' })
  statusId?: string;

  @ApiPropertyOptional()
  taskStatus?: {
    id: string;
    label: string;
    apiName: string;
    color: string;
    isTerminal: boolean;
  };

  @ApiProperty({ example: 'HIGH' })
  priority: TaskPriority | string;

  @ApiPropertyOptional({ example: 'call' })
  categoryId?: string;

  @ApiPropertyOptional()
  taskCategory?: { id: string; name: string; apiName: string };

  @ApiPropertyOptional({ type: 'string', example: '60d0fe4f5311236168a109cc' })
  ownerId?: string;

  /**
   * Node of the tenant's org tree this task belongs to.
   *
   * Read by the `org_unit` and `org_unit_subtree` data scopes. Present on the
   * domain object so a transfer between units is expressible at all — while the
   * mapper omitted it, the field could be stamped at create time and then never
   * changed.
   */
  @ApiPropertyOptional({ type: 'string' })
  orgUnitId?: string | null;

  @ApiPropertyOptional()
  relatedTo?: {
    type: string;
    id: string;
    name: string;
  };

  @ApiPropertyOptional({ example: ['follow-up'] })
  tags?: string[];

  @ApiPropertyOptional()
  reminderAt?: Date;

  /** Set when the reminder was actually dispatched, so it fires once. */
  @ApiPropertyOptional()
  reminderSentAt?: Date | null;

  @ApiPropertyOptional()
  completedAt?: Date | null;

  @ApiPropertyOptional({ example: 'manual' })
  sourceId?: string;

  @ApiPropertyOptional()
  taskSource?: { id: string; name: string };

  @ApiPropertyOptional({ required: false, type: Object })
  customFields?: Record<string, unknown>;

  // RECURRENCE

  @ApiPropertyOptional({ default: false })
  isRecurring?: boolean;

  @ApiPropertyOptional({ example: 'weekly' })
  recurrenceRule?: TaskRecurrenceRule;

  @ApiPropertyOptional({ example: 2 })
  recurrenceInterval?: number;

  @ApiPropertyOptional()
  recurrenceEndsAt?: Date | null;

  @ApiPropertyOptional()
  nextOccurrenceAt?: Date | null;

  @ApiPropertyOptional({
    description: 'Recurrence template this task spawned from',
  })
  parentTaskId?: string | null;

  // BOOKKEEPING

  @ApiPropertyOptional()
  createdById?: string;

  @ApiPropertyOptional()
  updatedById?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiPropertyOptional()
  deletedAt?: Date;

  /**
   * Mongo's `__v`, surfaced so a caller can write against the revision it read.
   *
   * `BaseDocumentRepository.updateIfExists` turns a defined version into a
   * compare-and-set predicate and answers `409` when it no longer matches. The
   * mapper used not to carry it, which left that predicate permanently
   * `undefined` — so the base class's concurrency protection existed, was
   * exercised by its own tests through other entities, and was inert for tasks.
   * Two people editing the same task simply overwrote each other in silence.
   */
  @ApiPropertyOptional({ description: 'Revision for optimistic locking' })
  version?: number;
}
