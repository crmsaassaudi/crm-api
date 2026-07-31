import { TasksService } from './tasks.service';

describe('TasksService export', () => {
  it('should queue the exact list query instead of browser-held rows', async () => {
    const queue = {} as any;
    const exportRequest = {
      enqueue: jest.fn().mockResolvedValue({
        jobId: 'job-1',
        status: 'queued',
      }),
    };
    const service = new TasksService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      queue,
      exportRequest as any,
      undefined,
      undefined,
    );
    const filters = [
      { id: 'status', value: ['open'] },
      { id: 'customFields.region', value: 'emea' },
    ];

    await service.exportTasks({
      format: 'xlsx',
      filters,
      search: 'renewal',
      columns: ['title', 'customFields.region'],
    });

    expect(exportRequest.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'task',
        queue,
        format: 'xlsx',
        columns: ['title', 'customFields.region'],
        legacyFilters: expect.objectContaining({
          filters,
          search: 'renewal',
        }),
        filterSnapshot: {
          ids: undefined,
          filters,
          search: 'renewal',
        },
      }),
    );
  });
});
