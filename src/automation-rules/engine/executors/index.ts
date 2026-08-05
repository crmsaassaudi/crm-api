/**
 * Barrel export for all action executors.
 *
 * One file per concern rather than one 2,253-line module with sixteen classes in
 * it. The split was started long ago — this directory existed as nothing but a
 * re-export of the monolith — and is now finished.
 */

export { ActionExecutor, ActionExecutionResult } from './executor.interface';

export {
  SendEmailExecutor,
  SendSmsExecutor,
  SendLivechatExecutor,
} from './messaging.executors';

export {
  InternalNotificationExecutor,
  AUTOMATION_NOTIFICATION_CHANNEL,
} from './notification.executor';

export {
  UpdateFieldExecutor,
  AddTagExecutor,
  RemoveTagExecutor,
  AddNoteExecutor,
  CreateRecordExecutor,
} from './record.executors';

export {
  RouteToGroupExecutor,
  AutomationAssigneeResolver,
  CreateTaskExecutor,
  CreateTicketExecutor,
} from './assignment.executors';

export { WebhookExecutor, HttpRequestExecutor } from './http.executors';
