import { Injectable } from '@nestjs/common';
import { AssignmentAdapter } from '../../core/ports';
import { AssignmentObjectType } from '../../domain/assignment.types';
import { RecordCandidatePort } from './record-candidate.port';
import { RecordLoadPort } from './record-load.port';
import { RecordCommitPort } from './record-commit.port';

/**
 * The adapter for CRM records.
 *
 * One adapter for all six record objectTypes rather than six near-identical
 * ones: they differ only by collection name and open-work filter, both of which
 * are data in `RecordLoadPort`.
 */
@Injectable()
export class RecordAssignmentAdapter implements AssignmentAdapter {
  readonly objectTypes: readonly AssignmentObjectType[] = [
    'Lead',
    'Contact',
    'Account',
    'Ticket',
    'Task',
    'Deal',
  ];

  constructor(
    readonly candidates: RecordCandidatePort,
    readonly load: RecordLoadPort,
    readonly commit: RecordCommitPort,
  ) {}
}
