/**
 * The facts about an inbound conversation that assignment rules can condition
 * on.
 *
 * Built by InboundOrchestrationService and flattened into the evaluator's
 * attribute bag by `AssignmentService.toAttributes()`. The keys there are the
 * rule-condition field names, so this interface and
 * `assignment/domain/assignment-fields.ts` describe the same set from the two
 * ends.
 */
export interface RoutingContext {
  /** Lowercase provider type: 'facebook', 'zalo', 'whatsapp', … */
  channel?: string;
  /**
   * The channel document id. Distinct from `channel`, which is only the
   * provider type — a tenant with three Facebook pages needs to route them
   * differently and the type alone cannot express that.
   */
  channelId?: string;
  /** Conversation tags. */
  tags?: string[];
  customerName?: string;
  /** Message text. */
  content?: string;
  /** "HH:mm" in the tenant timezone. */
  time?: string;
  /** Customer segment, e.g. 'VIP'. */
  segment?: string;
  /**
   * Inside or outside the tenant's business hours.
   *
   * A derived value rather than a raw timestamp: "route to the on-call team
   * after hours" is the rule people actually write, and expressing it with
   * `time` comparisons breaks the moment the schedule has two windows or a
   * holiday.
   */
  businessHours?: 'inside' | 'outside';
  /** Org unit of the conversation's contact, when known. */
  orgUnitId?: string;
  /** Detected or profile language, for language-based routing. */
  language?: string;
}
