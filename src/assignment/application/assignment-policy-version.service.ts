import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AssignmentObjectType } from '../domain/assignment.types';
import { AssignmentRule } from '../domain/assignment-rule';
import { ResolvedAssignmentConfig } from '../core/assignment-config.service';
import {
  AssignmentPolicyVersionDocument,
  AssignmentPolicyVersionSchemaClass,
} from '../infrastructure/persistence/assignment-policy-version.schema';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as any)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

@Injectable()
export class AssignmentPolicyVersionService {
  constructor(
    @InjectModel(AssignmentPolicyVersionSchemaClass.name)
    private readonly versions: Model<AssignmentPolicyVersionDocument>,
  ) {}

  async capture(
    tenantId: string,
    objectType: AssignmentObjectType,
    config: ResolvedAssignmentConfig,
    rules: AssignmentRule[],
  ): Promise<string> {
    const snapshot = { config, rules };
    const versionId = createHash('sha256')
      .update(stable(snapshot))
      .digest('hex');
    await this.versions.updateOne(
      { tenantId, objectType, versionId },
      {
        $setOnInsert: {
          tenantId,
          objectType,
          versionId,
          config,
          rules,
        },
      },
      { upsert: true },
    );
    return versionId;
  }
}
