import { SetMetadata } from '@nestjs/common';

export const MASKED_RESOURCE_KEY = 'masked_resource';
export const MaskedResource = (resourceName: string) => SetMetadata(MASKED_RESOURCE_KEY, resourceName);
