import { BadRequestException } from '@nestjs/common';
import { WorkflowDryRunService } from './workflow-dry-run.service';
import { ConditionEvaluatorService } from './condition-evaluator.service';
import { TemplateInterpolationService } from './template-interpolation.service';

/**
 * `automation_workflows:test` sat in the permission catalog with no route behind
 * it, so the only way to try a workflow was to publish it, activate it and create
 * a real record — i.e. to mail real customers in order to find out whether the
 * graph was wired correctly.
 */
describe('WorkflowDryRunService', () => {
  const emailNode = {
    id: 'email',
    type: 'action',
    config: {
      actionType: 'send_email',
      name: 'Welcome',
      subject: 'Hi {{firstName}}',
      template: 'Your code is {{promo.code}}',
      configId: 'cfg1',
    },
  };

  const build = (workflow: any, record: any = { firstName: 'Ada' }) => {
    const workflowRepo = { findById: jest.fn().mockResolvedValue(workflow) };
    const crmRecord = { fetchRecord: jest.fn().mockResolvedValue(record) };
    const cls = { get: jest.fn(() => 't1') };
    const service = new WorkflowDryRunService(
      workflowRepo as any,
      new ConditionEvaluatorService(),
      new TemplateInterpolationService(),
      crmRecord as any,
      cls as any,
    );
    return { service, crmRecord };
  };

  const linearWorkflow = () => ({
    name: 'W',
    triggerConfig: { event: 'record_created', object: 'Contact' },
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      {
        id: 'cond',
        type: 'condition',
        config: {
          logic: 'AND',
          rules: [{ field: 'status', operator: 'eq', value: 'New' }],
        },
      },
      emailNode,
      { id: 'other', type: 'action', config: { actionType: 'add_tag' } },
    ],
    edges: [
      { source: 'trigger', target: 'cond' },
      { source: 'cond', target: 'email', sourceHandle: 'matched' },
      { source: 'cond', target: 'other', sourceHandle: 'not_matched' },
    ],
  });

  it('should perform no side effect and report which actions would run', async () => {
    const { service } = build(linearWorkflow(), {
      firstName: 'Ada',
      status: 'New',
      promo: { code: 'X1' },
    });

    const result = await service.run('wf1', { recordId: 'rec1' });

    expect(result.actionsThatWouldRun).toEqual(['send_email']);
    const email = result.steps.find((s) => s.nodeId === 'email');
    expect(email?.outcome).toBe('taken');
    expect(email?.preview).toMatchObject({
      subject: 'Hi Ada',
      template: 'Your code is X1',
    });
  });

  it('should mark the branch that would not be taken instead of hiding it', async () => {
    const { service } = build(linearWorkflow(), {
      firstName: 'Ada',
      status: 'Old',
    });

    const result = await service.run('wf1', { recordId: 'rec1' });

    expect(result.actionsThatWouldRun).toEqual(['add_tag']);
    expect(result.steps.find((s) => s.nodeId === 'email')?.outcome).toBe(
      'not_taken',
    );
    expect(result.steps.find((s) => s.nodeId === 'cond')?.branch).toBe(
      'not_matched',
    );
  });

  it('should warn about tokens the sample record cannot resolve', async () => {
    // The common silent failure: `Hello {{contct.name}}` renders "Hello " and the
    // execution log says success.
    const { service } = build(linearWorkflow(), {
      firstName: 'Ada',
      status: 'New',
    });

    const result = await service.run('wf1', { recordId: 'rec1' });

    const email = result.steps.find((s) => s.nodeId === 'email');
    expect(email?.warnings?.join(' ')).toMatch(/promo\.code/);
  });

  it('should report the delay of a wait node without waiting', async () => {
    const workflow = {
      name: 'W',
      triggerConfig: { event: 'record_created', object: 'Contact' },
      nodes: [
        { id: 'trigger', type: 'trigger', config: {} },
        {
          id: 'wait',
          type: 'wait',
          config: { delayValue: 2, delayUnit: 'days' },
        },
      ],
      edges: [{ source: 'trigger', target: 'wait' }],
    };
    const { service } = build(workflow);

    const started = Date.now();
    const result = await service.run('wf1', { recordId: 'rec1' });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.steps.find((s) => s.nodeId === 'wait')?.delayMs).toBe(
      2 * 86_400_000,
    );
  });

  it('should refuse when neither a record nor sample data is supplied', async () => {
    const { service } = build(linearWorkflow());

    await expect(service.run('wf1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('should read the record with the caller’s own visibility', async () => {
    const { service, crmRecord } = build(linearWorkflow());

    await service.run('wf1', { recordId: 'rec1' });

    expect(crmRecord.fetchRecord).toHaveBeenCalledWith('Contact', 'rec1');
  });

  it('should refuse a record the caller cannot see', async () => {
    const { service } = build(linearWorkflow(), null);

    await expect(
      service.run('wf1', { recordId: 'not-mine' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
