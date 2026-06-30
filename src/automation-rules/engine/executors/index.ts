/**
 * Barrel export for all action executors.
 *
 * New consumers should import from this directory:
 *   import { SendEmailExecutor, ActionExecutor } from './executors';
 *
 * The interfaces are defined in executor.interface.ts.
 * All executor implementations are currently in the parent action-executors.ts
 * and re-exported here for a clean public API.
 */

// ── Interfaces ──────────────────────────────────────────────────────────────
export {
  ActionExecutor,
  ActionExecutionResult,
} from './executor.interface';

// ── Executor Implementations ────────────────────────────────────────────────
export {
  SendEmailExecutor,
  SendSmsExecutor,
  UpdateFieldExecutor,
  RouteToTeamExecutor,
  WebhookExecutor,
  CreateTaskExecutor,
  CreateTicketExecutor,
  AddTagExecutor,
  RemoveTagExecutor,
  AddNoteExecutor,
  CreateRecordExecutor,
  HttpRequestExecutor,
  SendWhatsAppExecutor,
  SendZnsExecutor,
  SendLivechatExecutor,
  InternalNotificationExecutor,
} from '../action-executors';
