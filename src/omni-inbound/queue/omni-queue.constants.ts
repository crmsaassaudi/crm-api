/** Queue name constant shared between controller (producer) and processor (consumer). */
export const OMNI_WEBHOOK_QUEUE = 'omni-webhooks';
export const OMNI_ROUTING_QUEUE = 'omni-routing';

/** BullMQ priority: lower number = higher priority */
export const PRIORITY_VIP = 1;
export const PRIORITY_NORMAL = 10;
