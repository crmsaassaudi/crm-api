import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Reflector } from '@nestjs/core';
import { MASKED_RESOURCE_KEY } from '../decorators/masked-resource.decorator';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class DataMaskingInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly settingsService: CrmSettingsService,
    private readonly cls: ClsService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const resourceName = this.reflector.get<string>(
      MASKED_RESOURCE_KEY,
      context.getHandler(),
    ) || this.reflector.get<string>(
      MASKED_RESOURCE_KEY,
      context.getClass(),
    );

    if (!resourceName) {
      return next.handle();
    }

    const groupId = this.cls.get('userGroupId') || 'default';

    const layoutSettings = await this.settingsService.getSetting('layout_settings');
    const layoutConfig = layoutSettings?.groupLayouts?.[groupId] || layoutSettings?.groupLayouts?.['default'];
    
    if (!layoutConfig) {
      return next.handle();
    }

    // BASE resource for request sanitization
    const baseMaskedFields = this.getMaskedFields(layoutConfig, resourceName);
    
    const request = context.switchToHttp().getRequest();
    if (['POST', 'PATCH', 'PUT'].includes(request.method) && request.body && baseMaskedFields.size > 0) {
      for (const [field, maskingType] of baseMaskedFields.entries()) {
        const value = request.body[field];
        if (typeof value === 'string' && value.includes('***')) {
          delete request.body[field];
        } else if (Array.isArray(value)) {
          if (value.some(v => typeof v === 'string' && v.includes('***'))) {
            delete request.body[field];
          }
        }
      }
    }

    return next.handle().pipe(
      map(data => this.maskData(data, layoutConfig, resourceName)),
    );
  }

  private maskData(data: any, layoutConfig: any, baseResource: string): any {
    if (!data) return data;

    // Handle paginated results
    if (data.data && Array.isArray(data.data)) {
      return {
        ...data,
        data: data.data.map((item: any) => this.maskItem(item, layoutConfig, baseResource))
      };
    }

    if (Array.isArray(data)) {
      return data.map(item => this.maskItem(item, layoutConfig, baseResource));
    }

    return this.maskItem(data, layoutConfig, baseResource);
  }

  private maskItem(item: any, layoutConfig: any, baseResource: string): any {
    if (typeof item !== 'object' || item === null) return item;

    let target = item;
    if (item.toJSON && typeof item.toJSON === 'function') {
      target = item.toJSON();
    } else {
      target = { ...item };
    }

    // Dynamic resource determination for Contact/Lead
    let resource = baseResource;
    if (baseResource === 'Contact' || baseResource === 'Lead') {
      if (target.isConverted === false) {
        resource = 'Lead';
      } else if (target.isConverted === true) {
        resource = 'Contact';
      }
    }

    const maskedFields = this.getMaskedFields(layoutConfig, resource);
    if (maskedFields.size === 0) return target;

    for (const [field, maskingType] of maskedFields.entries()) {
      const value = target[field];
      if (value === undefined || value === null) continue;

      if (typeof value === 'string') {
        target[field] = this.applyMask(value, maskingType);
      } else if (Array.isArray(value)) {
        target[field] = value.map(v => typeof v === 'string' ? this.applyMask(v, maskingType) : v);
      }
    }

    return target;
  }

  private getMaskedFields(layoutConfig: any, resource: string): Map<string, string> {
    const fields = new Map<string, string>();
    const configs = layoutConfig?.[resource];
    if (!configs || !Array.isArray(configs)) return fields;

    for (const config of configs) {
      if (config.masking && config.masking !== 'none') {
        fields.set(config.key, config.masking);
      }
    }
    return fields;
  }

  private applyMask(value: string, maskingType: string): string {
    if (!value || value.includes('***')) return value;
    if (maskingType === 'mask_all') {
      return '********';
    } else if (maskingType === 'last_4') {
      if (value.length <= 4) {
        return '********';
      } else {
        return '****' + value.substring(value.length - 4);
      }
    }
    return value;
  }
}
