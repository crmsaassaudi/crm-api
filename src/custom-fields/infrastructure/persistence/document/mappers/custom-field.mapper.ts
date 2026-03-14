import { CustomField } from '../../../../domain/custom-field';
import { CustomFieldSchemaClass } from '../entities/custom-field.schema';

export class CustomFieldMapper {
  static toDomain(raw: CustomFieldSchemaClass): CustomField {
    const domain = new CustomField();
    domain.id = raw._id.toString();
    domain.tenant = raw.tenant;
    domain.module = raw.module;
    domain.internalKey = raw.internalKey;
    domain.displayLabel = raw.displayLabel;
    domain.fieldType = raw.fieldType;
    domain.isActive = raw.isActive;
    domain.section = raw.section;
    domain.orderIndex = raw.orderIndex;
    domain.validation = raw.validation;
    domain.governance = raw.governance;
    domain.objectView = raw.objectView;
    domain.placeholder = raw.placeholder;
    domain.options = raw.options;
    domain.createdAt = raw.createdAt;
    domain.updatedAt = raw.updatedAt;
    return domain;
  }
}
