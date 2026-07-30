/** Queue name constant shared between controller (producer) and processor (consumer). */
export const OMNI_WEBHOOK_QUEUE = 'omni-webhooks';
export const OMNI_ROUTING_QUEUE = 'omni-routing';

/** BullMQ priority: lower number = higher priority */
export const PRIORITY_NORMAL = 10;

// Removed: `PRIORITY_VIP = 1`. Every inbound job was enqueued at PRIORITY_NORMAL, so
// the tier existed only as a claim that VIP traffic gets ahead of the queue.
//
// It cannot be filled in without a decision, which is why it stayed empty: inbound
// webhooks are enqueued BEFORE contact resolution, so at the point this priority is
// chosen the code does not yet know whose message it is. Making VIP real means either
// resolving identity in the webhook handler (moving work into the latency-critical
// path) or re-prioritising later in the pipeline. That is a design call, not a
// constant.
