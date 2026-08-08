/**
 * Queue names and batch sizes for campaign delivery.
 *
 * Two queues rather than one, because the two halves of a send have opposite
 * shapes: materialising an audience is ONE long job per campaign that walks a
 * cursor, while sending is thousands of short jobs that each wait on a provider.
 * Sharing a queue would let one 500k-contact materialisation starve every other
 * tenant's sends behind it.
 */
export const CAMPAIGN_DISPATCH_QUEUE = 'campaign-dispatch';
export const CAMPAIGN_SEND_QUEUE = 'campaign-send';

export const CAMPAIGN_DISPATCH_JOB = 'dispatch-campaign';
export const CAMPAIGN_SEND_JOB = 'send-batch';

/**
 * How many recipients one send job carries.
 *
 * Small enough that a crashed worker replays little work, large enough that
 * queue overhead stays a rounding error next to the provider round trips.
 */
export const CAMPAIGN_SEND_BATCH_SIZE = 100;

/** Cursor batch size while walking the audience. */
export const CAMPAIGN_MATERIALISE_BATCH_SIZE = 500;

/**
 * How long the wizard's audience count may run before it gives up.
 *
 * An audience predicate is rarely index-covered, so on a large tenant the count
 * is a scan. Three seconds is roughly the point past which someone assumes the
 * page is broken, and a preview that says "could not count in time" is more
 * useful than one that never returns.
 */
export const CAMPAIGN_PREVIEW_TIMEOUT_MS = 3_000;

/**
 * Hard ceiling on one campaign's audience.
 *
 * Not a licensing limit — a blast wider than this is nearly always a segment
 * mistake (an empty condition tree that matched the whole tenant), and finding
 * that out from the provider's abuse team costs more than a refused launch.
 */
export const CAMPAIGN_MAX_AUDIENCE = 500_000;
