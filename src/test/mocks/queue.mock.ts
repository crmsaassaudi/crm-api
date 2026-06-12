/**
 * Standard BullMQ Queue mock for unit tests.
 */
export function createQueueMock() {
  return {
    add: jest.fn().mockResolvedValue({ id: 'job_1' }),
    getJob: jest.fn().mockResolvedValue(null),
    getJobs: jest.fn().mockResolvedValue([]),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0 }),
    obliterate: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}
