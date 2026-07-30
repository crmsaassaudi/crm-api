import { canTransitionWorkItem } from './work-item-status';

describe('work item state machine', () => {
  it('should supports the offer lifecycle and idempotent transitions', () => {
    expect(canTransitionWorkItem('queued', 'offered')).toBe(true);
    expect(canTransitionWorkItem('offered', 'assigned')).toBe(true);
    expect(canTransitionWorkItem('assigned', 'active')).toBe(true);
    expect(canTransitionWorkItem('active', 'wrap_up')).toBe(true);
    expect(canTransitionWorkItem('wrap_up', 'completed')).toBe(true);
    expect(canTransitionWorkItem('queued', 'queued')).toBe(true);
  });

  it('should keeps completed work terminal', () => {
    expect(canTransitionWorkItem('completed', 'queued')).toBe(false);
    expect(canTransitionWorkItem('completed', 'active')).toBe(false);
  });
});
