export type WorkItemStatus =
  | 'queued'
  | 'offered'
  | 'assigned'
  | 'active'
  | 'wrap_up'
  | 'completed';

const transitions: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  queued: ['offered', 'assigned', 'completed'],
  offered: ['queued', 'assigned', 'completed'],
  assigned: ['active', 'queued', 'completed'],
  active: ['wrap_up', 'queued', 'completed'],
  wrap_up: ['completed', 'active'],
  completed: [],
};

export function canTransitionWorkItem(
  from: WorkItemStatus,
  to: WorkItemStatus,
): boolean {
  return from === to || transitions[from].includes(to);
}
