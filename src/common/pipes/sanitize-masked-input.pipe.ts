import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';

@Injectable()
export class SanitizeMaskedInputPipe implements PipeTransform {
  transform(value: any, metadata: ArgumentMetadata) {
    if (metadata.type !== 'body' || !value || typeof value !== 'object') {
      return value;
    }

    return this.sanitizeItem(value);
  }

  private sanitizeItem(item: any): any {
    if (item === null || typeof item !== 'object') {
      return item;
    }

    if (Array.isArray(item)) {
      return item
        .filter((v) => !(typeof v === 'string' && v.includes('***')))
        .map((v) => this.sanitizeItem(v));
    }

    const sanitized = { ...item };
    for (const key of Object.keys(sanitized)) {
      const value = sanitized[key];
      if (typeof value === 'string' && value.includes('***')) {
        delete sanitized[key];
      } else if (value && typeof value === 'object') {
        sanitized[key] = this.sanitizeItem(value);
      }
    }
    return sanitized;
  }
}
