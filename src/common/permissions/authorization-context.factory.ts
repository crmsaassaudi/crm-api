import { Injectable } from '@nestjs/common';
import { AbacContext } from './abac.evaluator';

export interface AuthorizationSubjectInput {
  tenantId: string;
  userId: string;
  principalType?: string;
  groupIds?: string[];
  attributes?: Record<string, unknown>;
}

export interface AuthorizationEnvironmentInput {
  ip?: string;
  attributes?: Record<string, unknown>;
  now?: Date;
}

/**
 * The single trusted constructor for ABAC inputs.
 *
 * Caller-provided attributes are useful for domain-specific policy fields, but
 * they must never replace canonical identity, tenant, principal, membership,
 * time or network values. Canonical fields are therefore assigned last.
 */
@Injectable()
export class AuthorizationContextFactory {
  forAction(
    subject: AuthorizationSubjectInput,
    environment: AuthorizationEnvironmentInput = {},
  ): AbacContext {
    return {
      subject: this.buildSubject(subject),
      env: this.buildEnvironment(environment),
    };
  }

  forRecord(
    subject: AuthorizationSubjectInput,
    resourceId: string,
    record?: Record<string, unknown>,
    environment: AuthorizationEnvironmentInput = {},
  ): AbacContext {
    return {
      subject: this.buildSubject(subject),
      resource: { ...(record ?? {}), id: resourceId },
      env: this.buildEnvironment(environment),
    };
  }

  private buildSubject(
    input: AuthorizationSubjectInput,
  ): Record<string, unknown> {
    return {
      ...(input.attributes ?? {}),
      id: String(input.userId),
      tenantId: String(input.tenantId),
      principalType: input.principalType ?? 'user',
      groupIds: [...new Set((input.groupIds ?? []).map(String))],
    };
  }

  private buildEnvironment(
    input: AuthorizationEnvironmentInput,
  ): Record<string, unknown> {
    return {
      ...(input.attributes ?? {}),
      now: input.now ?? new Date(),
      ...(input.ip ? { ip: input.ip } : {}),
    };
  }
}
