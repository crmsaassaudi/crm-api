import { Injectable } from '@nestjs/common';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { isFieldType, isMaskableFieldType } from '../custom-fields/field-type';
import { CustomField } from '../custom-fields/domain/custom-field';
import { LayoutSettingsService } from './layout/layout-settings.service';
import {
  ObjectPicklists,
  PicklistProvider,
} from './picklists/picklist.provider';
import {
  CONFIGURABLE_OBJECTS,
  ConfigurableObject,
  StandardFieldDescriptor,
  isFieldMaskable,
  isFieldRequirable,
} from './object-registry';
import { ObjectRegistryService, columnKeyOf } from './object-registry.service';
import {
  FieldPolicyDto,
  ObjectConfigDto,
  ObjectDescriptorDto,
  ObjectFieldDto,
} from './dto/object-config.dto';
import { ACCESS_LEVELS, MASKING_STRATEGIES } from './layout/field-policy';

/**
 * Assembles everything a client needs to render an object's forms and lists.
 *
 * Why one endpoint instead of the seven it replaces
 *
 * Rendering a single list page used to issue: one request per module for standard
 * fields (served from a browser constant, so not really a request at all), one for
 * custom fields, one for `layout_settings`, plus list views. Three of those were
 * gated on `settings:view`, which no built-in role except Administrator holds — so
 * for a Sales Rep or a Support Agent they returned 403 and the client fell back to
 * "no restrictions": field-level security evaporated for exactly the people it
 * exists to restrict, and custom-field columns vanished for everyone else.
 *
 * Collapsing it into one self-scoped read fixes both halves. There is no
 * authorization decision to make — the response contains the caller's own policy
 * and the tenant's own field catalog, neither of which they could not discover by
 * using the app — so it needs authentication and nothing more. Same reasoning, and
 * same shape, as `GET /me/permissions`.
 */
@Injectable()
export class ObjectConfigService {
  constructor(
    private readonly registry: ObjectRegistryService,
    private readonly layouts: LayoutSettingsService,
    private readonly customFields: CustomFieldsService,
    private readonly picklists: PicklistProvider,
  ) {}

  async forCaller(scope?: object): Promise<ObjectConfigDto> {
    // One settings read and one custom-fields read per object, all concurrent.
    // The settings read is memoised per request by LayoutSettingsService, so the
    // five policies below cost a single document fetch between them.
    const [objects, policyEntries] = await Promise.all([
      Promise.all(CONFIGURABLE_OBJECTS.map((object) => this.describe(object))),
      Promise.all(
        CONFIGURABLE_OBJECTS.map(
          async (object) => [object, await this.policy(object, scope)] as const,
        ),
      ),
    ]);

    return {
      objects,
      policies: Object.fromEntries(policyEntries) as Partial<
        Record<ConfigurableObject, FieldPolicyDto>
      >,
      accessLevels: ACCESS_LEVELS,
      maskingStrategies: MASKING_STRATEGIES,
    };
  }

  private async describe(
    object: ConfigurableObject,
  ): Promise<ObjectDescriptorDto> {
    const [custom, picklists] = await Promise.all([
      this.loadCustomFields(object),
      this.picklists.forObject(object),
    ]);
    return {
      name: object,
      fields: [
        ...this.registry
          .fields(object)
          .map((field) => toStandardFieldDto(field, picklists)),
        ...custom.map(toCustomFieldDto),
      ],
    };
  }

  private async policy(
    object: ConfigurableObject,
    scope?: object,
  ): Promise<FieldPolicyDto> {
    const policy = await this.layouts.policyFor(object, scope);
    return {
      hidden: [...policy.hidden],
      readOnly: [...policy.readOnly],
      masking: Object.fromEntries(policy.masking),
      required: [...policy.required],
    };
  }

  private async loadCustomFields(
    object: ConfigurableObject,
  ): Promise<CustomField[]> {
    const fields = await this.customFields.getByModule(object);
    return fields.filter((field) => field.isActive !== false);
  }
}

const toStandardFieldDto = (
  field: StandardFieldDescriptor,
  picklists: ObjectPicklists,
): ObjectFieldDto => ({
  key: field.key,
  column: columnKeyOf(field),
  labelToken: field.labelToken,
  type: field.type,
  category: field.category,
  readOnly: field.readOnly === true,
  audit: field.audit === true,
  maskable: isFieldMaskable(field),
  requirable: isFieldRequirable(field),
  isStandard: true,
  // Attached by payload key. A form and a validation rule therefore cannot end up
  // describing different fields under the same label, which is exactly what the
  // separate status endpoint allowed.
  ...(picklists[field.key] ? { options: picklists[field.key] } : {}),
});

const toCustomFieldDto = (field: CustomField): ObjectFieldDto => {
  // A custom field's stored `fieldType` is a string until the DTO started
  // validating it, so documents predating that check can hold anything. An
  // unrecognised type is reported as TEXT rather than passed through: the client
  // switches on this value to pick an input, and an unknown one renders nothing.
  const type = isFieldType(field.fieldType) ? field.fieldType : 'TEXT';
  return {
    key: field.internalKey,
    column: field.internalKey,
    labelToken: '',
    type,
    category: field.section || 'custom',
    readOnly: type === 'FORMULA',
    audit: false,
    maskable: isMaskableFieldType(type),
    requirable: type !== 'FORMULA',
    isStandard: false,
    options: field.options,
  };
};
