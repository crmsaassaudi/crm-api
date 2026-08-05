import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { ConfigurableObject } from '../object-registry';
import {
  MaskingStrategy,
  ResolvedFieldPolicy,
  applyMask,
} from './field-policy';
import { LayoutSettingsService } from './layout-settings.service';
import { OBJECT_FIELD_POLICY_KEY } from './object-field-policy.decorator';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT']);

/**
 * Enforces the tenant's field-level policy on both directions of a request.
 *
 * What it replaces, and why the replacement is larger
 *
 * `DataMaskingInterceptor` applied exactly one of the three settings Object
 * Manager offers. `accessLevel: 'hidden'` and `accessLevel: 'read_only'` were read
 * only by the browser, so a hidden field was still in the JSON and a read-only
 * field still accepted writes — the settings screen described a control that
 * existed only as a rendering hint. A field-level *security* setting that the API
 * does not enforce is not a weaker control, it is not a control.
 *
 * So all three are enforced here:
 *   hidden     → the property is deleted from the response, and refused on write.
 *   read_only  → the property is stripped from the request body.
 *   masking    → the value is rewritten on the way out.
 *
 * Why hidden refuses the write instead of stripping it
 *
 * A read-only field is one the caller can see and not change: dropping it from the
 * body is the honest outcome, and a form that round-trips the value it was given
 * must not fail because of a field the user never touched. A hidden field is one
 * the caller cannot see at all, so a value for it can only have been constructed
 * deliberately — silently discarding that reads as success and leaves the caller
 * believing they set something. 403 is the accurate answer.
 */
@Injectable()
export class FieldPolicyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly layouts: LayoutSettingsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const object = this.reflector.getAllAndOverride<ConfigurableObject>(
      OBJECT_FIELD_POLICY_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!object) return next.handle();

    const request = context.switchToHttp().getRequest();

    return from(this.layouts.policyFor(object, request)).pipe(
      switchMap((policy) => {
        if (isNoop(policy)) return next.handle();

        this.guardRequest(request, policy);

        return next
          .handle()
          .pipe(switchMap((data) => [this.applyToResponse(data, policy)]));
      }),
    );
  }

  private guardRequest(request: any, policy: ResolvedFieldPolicy): void {
    const body = request?.body;
    if (!WRITE_METHODS.has(request?.method) || !isPlainRecord(body)) return;

    const forbidden = [...policy.hidden].filter((key) => key in body);
    if (forbidden.length > 0) {
      throw new ForbiddenException(
        `Field${forbidden.length > 1 ? 's' : ''} not visible to you: ${forbidden.join(', ')}`,
      );
    }

    for (const key of policy.readOnly) {
      if (key in body) delete body[key];
    }
  }

  private applyToResponse(data: any, policy: ResolvedFieldPolicy): any {
    if (!data) return data;

    // Paginated envelope — the shape every list endpoint in the API returns.
    if (Array.isArray((data as any).data)) {
      return {
        ...data,
        data: (data as any).data.map((item: unknown) =>
          this.applyToRecord(item, policy),
        ),
      };
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.applyToRecord(item, policy));
    }

    return this.applyToRecord(data, policy);
  }

  private applyToRecord(item: unknown, policy: ResolvedFieldPolicy): unknown {
    if (typeof item !== 'object' || item === null) return item;

    const record = toPlainRecord(item);

    for (const key of policy.hidden) {
      delete record[key];
    }

    for (const [key, strategy] of policy.masking) {
      // A hidden field is already gone; masking it again would be a no-op, and
      // checking is cheaper than the string work.
      if (policy.hidden.has(key)) continue;
      record[key] = maskValue(record[key], strategy);
    }

    return record;
  }
}

const maskValue = (value: unknown, strategy: MaskingStrategy): unknown => {
  if (typeof value === 'string') return applyMask(value, strategy);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      typeof entry === 'string' ? applyMask(entry, strategy) : entry,
    );
  }
  // Numbers, dates and objects are left alone: the registry only offers masking on
  // string-shaped types, so reaching here means the stored policy predates that
  // rule. Rewriting a number into '********' would break the client's parser,
  // which is a worse outcome than an un-masked value the UI never offered to mask.
  return value;
};

const isNoop = (policy: ResolvedFieldPolicy): boolean =>
  policy.hidden.size === 0 &&
  policy.readOnly.size === 0 &&
  policy.masking.size === 0;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toPlainRecord = (item: object): Record<string, unknown> => {
  const maybeDocument = item as { toJSON?: () => Record<string, unknown> };
  return typeof maybeDocument.toJSON === 'function'
    ? maybeDocument.toJSON()
    : { ...(item as Record<string, unknown>) };
};
