import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { SENSITIVE_RESOURCE_KEY } from './sensitive-resource.decorator';
import {
  FIELD_SENSITIVITY,
  SensitiveField,
  maskValue,
} from './field-sensitivity.registry';
import { AuthorizationService } from './authorization.service';
import { PrincipalType } from './principal';

/**
 * FieldMaskingInterceptor — permission-driven PII/financial masking on the
 * response. For a `@SensitiveResource(...)` handler it computes, once per
 * request, which sensitive fields the principal may see unmasked (via the PDP),
 * then rewrites the outgoing payload. Never mutates persisted documents.
 *
 * Rules:
 *   - AI-agent principals are ALWAYS masked (no unmask, ever).
 *   - Otherwise a field is unmasked only if the principal holds its unmask
 *     permission; unknown/denied → masked (fail-closed).
 */
@Injectable()
export class FieldMaskingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(FieldMaskingInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthorizationService,
    private readonly cls: ClsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const resource =
      this.reflector.get<string>(
        SENSITIVE_RESOURCE_KEY,
        context.getHandler(),
      ) ||
      this.reflector.get<string>(SENSITIVE_RESOURCE_KEY, context.getClass());

    const fields = resource ? FIELD_SENSITIVITY[resource] : undefined;
    if (!fields?.length) return next.handle();

    const request = context.switchToHttp().getRequest();

    return next
      .handle()
      .pipe(
        switchMap((data) => from(this.maskResponse(data, fields, request))),
      );
  }

  private async maskResponse(
    data: any,
    fields: SensitiveField[],
    request: any,
  ): Promise<any> {
    if (!data) return data;

    const rawUserId = String(
      this.cls.get<string>('userId') ??
        request.user?.userId ??
        request.user?.sub ??
        '',
    );
    const tenantHint =
      this.cls.get<string>('tenantId') ?? request.user?.tenantId;
    const principalType =
      this.cls.get<string>('principalType') ??
      request.user?.principalType ??
      PrincipalType.USER;

    // Which sensitive fields must be masked for this principal?
    const toMask = await this.resolveMaskedFields(
      fields,
      rawUserId,
      tenantHint,
      principalType,
      request.user,
    );
    if (toMask.length === 0) return data; // fully cleared → nothing to do

    return this.maskData(data, toMask);
  }

  private async resolveMaskedFields(
    fields: SensitiveField[],
    rawUserId: string,
    tenantHint: string | undefined,
    principalType: string,
    claims: any,
  ): Promise<SensitiveField[]> {
    // Agents never see PII unmasked — short-circuit, no PDP call needed.
    if (principalType === PrincipalType.AGENT) return fields;
    if (!rawUserId) return fields; // no identity → fail closed

    // Evaluate each distinct unmask permission once.
    const decisionCache = new Map<string, boolean>();
    const masked: SensitiveField[] = [];
    for (const f of fields) {
      const key = `${f.unmask.resource}:${f.unmask.action}`;
      let allowed = decisionCache.get(key);
      if (allowed === undefined) {
        allowed = await this.canUnmask(f, rawUserId, tenantHint, claims);
        decisionCache.set(key, allowed);
      }
      if (!allowed) masked.push(f);
    }
    return masked;
  }

  private async canUnmask(
    field: SensitiveField,
    rawUserId: string,
    tenantHint: string | undefined,
    claims: any,
  ): Promise<boolean> {
    try {
      const decision = await this.authz.canPerformAction({
        rule: { action: field.unmask.action, resource: field.unmask.resource },
        rawUserId,
        tenantHint: tenantHint ? String(tenantHint) : undefined,
        claims,
      });
      return decision.allowed;
    } catch (error) {
      this.logger.warn(
        `Unmask check failed for ${field.unmask.resource}:${field.unmask.action}; masking: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false; // fail closed
    }
  }

  private maskData(data: any, fields: SensitiveField[]): any {
    if (Array.isArray(data)) return data.map((i) => this.maskItem(i, fields));
    if (data?.data && Array.isArray(data.data)) {
      return {
        ...data,
        data: data.data.map((i: any) => this.maskItem(i, fields)),
      };
    }
    return this.maskItem(data, fields);
  }

  private maskItem(item: any, fields: SensitiveField[]): any {
    if (typeof item !== 'object' || item === null) return item;
    const target =
      typeof item.toJSON === 'function' ? item.toJSON() : { ...item };
    for (const f of fields) {
      this.maskPath(target, f.field.split('.'), f.strategy);
    }
    return target;
  }

  /**
   * Mask a field addressed by a dotted path, e.g. `customer.email`.
   *
   * A flat `target[field]` lookup could only reach top-level keys, which meant the
   * registry was unable to describe PII nested inside a sub-document however
   * accurately it named it — the same class of limitation as declaring `email` for a
   * document that serialises `emails`: the registry can only express what this method
   * can read.
   *
   * Each level is shallow-copied on the way down. `{ ...item }` above copies only the
   * top level, so `target.customer` is still the SAME object as the source document's
   * — writing through it would mutate the persisted document, breaking the promise in
   * this class's own doc comment. Cloning the path keeps the response a projection.
   */
  private maskPath(
    target: Record<string, any>,
    path: string[],
    strategy: SensitiveField['strategy'],
  ): void {
    const [head, ...rest] = path;
    if (head === undefined) return;

    const current = target[head];
    if (current === undefined || current === null) return;

    if (rest.length === 0) {
      target[head] = maskValue(current, strategy);
      return;
    }

    // An array of sub-documents (`items.0.email` is not addressed; every element is).
    if (Array.isArray(current)) {
      target[head] = current.map((entry) => {
        if (typeof entry !== 'object' || entry === null) return entry;
        const clone = { ...entry };
        this.maskPath(clone, rest, strategy);
        return clone;
      });
      return;
    }

    if (typeof current !== 'object') return;
    const clone = { ...current };
    this.maskPath(clone, rest, strategy);
    target[head] = clone;
  }
}
