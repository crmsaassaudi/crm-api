import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Global interceptor that enforces a single ID convention for all API responses:
 *   • Renames `_id` → `id` (if `id` is not already present)
 *   • Removes `__v` (Mongoose version key)
 *
 * Runs recursively on every object / array in the response payload so that
 * nested / populated sub-documents are also normalised.
 */
@Injectable()
export class NormalizeIdInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => this.normalize(data)));
  }

  private normalize(value: unknown): unknown {
    if (value === null || value === undefined) return value;

    // Primitive
    if (typeof value !== 'object') return value;

    // Date – keep as-is
    if (value instanceof Date) return value;

    // Array
    if (Array.isArray(value)) {
      return value.map((item) => this.normalize(item));
    }

    // Mongoose document that hasn't been converted to POJO yet
    if (typeof (value as any).toJSON === 'function') {
      value = (value as any).toJSON();
    }

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(obj)) {
      if (key === '__v') continue; // strip version key

      if (key === '_id') {
        // Only promote _id → id when id is not already set
        if (!('id' in obj)) {
          result['id'] = this.normalizeId(obj['_id']);
        }
        continue;
      }

      result[key] = this.normalize(obj[key]);
    }

    return result;
  }

  /** Convert ObjectId instances to string */
  private normalizeId(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value;
    if (typeof (value as any).toString === 'function') {
      return (value as any).toString();
    }
    return value;
  }
}
