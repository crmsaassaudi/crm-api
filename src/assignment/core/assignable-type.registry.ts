import { ConflictException, Injectable } from '@nestjs/common';
import {
  ASSIGNMENT_OBJECT_TYPES,
  AssignmentObjectType,
} from '../domain/assignment.types';

export interface AssignableTypeDescriptor {
  objectType: AssignmentObjectType;
  preferredAssignee: boolean;
  onlineHardGate: boolean;
  durableQueue: boolean;
}

@Injectable()
export class AssignableTypeRegistry {
  private readonly descriptors = new Map<
    AssignmentObjectType,
    AssignableTypeDescriptor
  >();

  constructor() {
    for (const objectType of ASSIGNMENT_OBJECT_TYPES) {
      this.register({
        objectType,
        preferredAssignee: objectType === 'Conversation',
        onlineHardGate: true,
        durableQueue: objectType !== 'Conversation',
      });
    }
  }

  register(descriptor: AssignableTypeDescriptor): void {
    if (this.descriptors.has(descriptor.objectType)) {
      throw new ConflictException(
        `Assignable type "${descriptor.objectType}" is already registered`,
      );
    }
    this.descriptors.set(
      descriptor.objectType,
      Object.freeze({ ...descriptor }),
    );
  }

  has(value: string): value is AssignmentObjectType {
    return this.descriptors.has(value as AssignmentObjectType);
  }

  list(): readonly AssignableTypeDescriptor[] {
    return Object.freeze([...this.descriptors.values()]);
  }
}
