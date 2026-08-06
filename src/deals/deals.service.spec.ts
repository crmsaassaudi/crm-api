import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DEAL_ERRORS } from './constants/deal-error-codes';
import { DealsService } from './deals.service';
import { DEFAULT_DEAL_RULES } from './deals.constants';
import { createClsMock } from '../test/mocks/cls.mock';
import { createEventBusMock } from '../test/mocks/event-bus.mock';

const PIPELINE = 'pipeline_1';
const OPEN_STAGE = 'stage_open';
const WON_STAGE = 'stage_won';
const LOST_STAGE = 'stage_lost';

const STAGES: Record<string, any> = {
  [OPEN_STAGE]: {
    pipelineId: PIPELINE,
    stageId: OPEN_STAGE,
    probability: 20,
    isWon: false,
    isLost: false,
  },
  [WON_STAGE]: {
    pipelineId: PIPELINE,
    stageId: WON_STAGE,
    probability: 100,
    isWon: true,
    isLost: false,
  },
  [LOST_STAGE]: {
    pipelineId: PIPELINE,
    stageId: LOST_STAGE,
    probability: 0,
    isWon: false,
    isLost: true,
  },
};

/** BusinessException carries the machine-readable code; the message is prose. */
const expectBusinessCode = async (
  promise: Promise<unknown>,
  errorCode: string,
) => {
  await expect(promise).rejects.toMatchObject({ errorCode });
};

/** A deal as `repository.findOne` would return it. */
const existingDeal = (overrides: Record<string, any> = {}) => ({
  id: 'deal_1',
  title: 'Existing',
  pipelineId: PIPELINE,
  stageId: OPEN_STAGE,
  value: 1000,
  ownerId: 'user_1',
  contactIds: ['contact_1'],
  stageEnteredAt: new Date('2026-08-01T00:00:00Z'),
  ...overrides,
});

describe('DealsService', () => {
  let service: DealsService;
  let repository: any;
  let dealSettings: any;
  let dealRules: any;
  let authorization: any;
  let cls: ReturnType<typeof createClsMock>;
  let eventEmitter: ReturnType<typeof createEventBusMock>;
  let entityAudit: any;
  let importStorage: any;
  let importQueue: any;
  let exportQueue: any;
  let importJobModel: any;
  let exportRequest: any;

  beforeEach(() => {
    repository = {
      create: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ id: 'deal_new', ...data }),
        ),
      findOne: jest.fn().mockResolvedValue(null),
      findManyWithPagination: jest
        .fn()
        .mockResolvedValue({ data: [], hasNextPage: false }),
      findManyByCursor: jest
        .fn()
        .mockResolvedValue({ data: [], nextCursor: null }),
      boardSummary: jest.fn().mockResolvedValue([]),
      update: jest
        .fn()
        .mockImplementation((id, data) => Promise.resolve({ id, ...data })),
      appendStageHistory: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      existsOpenDuplicate: jest.fn().mockResolvedValue(false),
    };

    dealSettings = {
      resolvePlacement: jest.fn(({ stageId }: any) => {
        const stage = STAGES[stageId ?? OPEN_STAGE];
        return stage
          ? Promise.resolve(stage)
          : Promise.reject(new BadRequestException('unknown stage'));
      }),
      describeStage: jest.fn((stageId: string) =>
        Promise.resolve(STAGES[stageId] ?? null),
      ),
    };

    dealRules = { get: jest.fn().mockResolvedValue(DEFAULT_DEAL_RULES) };

    cls = createClsMock();
    eventEmitter = createEventBusMock();
    entityAudit = { emit: jest.fn() };

    importStorage = {
      storeImportFile: jest
        .fn()
        .mockResolvedValue({ fileKey: 'deals/test.csv' }),
      importFileExists: jest.fn().mockResolvedValue(true),
    };

    importQueue = {
      add: jest.fn().mockResolvedValue({ id: 'bull_job_1' }),
      getJob: jest.fn().mockResolvedValue(null),
    };
    exportQueue = { add: jest.fn().mockResolvedValue({ id: 'export_1' }) };
    importJobModel = { create: jest.fn().mockResolvedValue({}) };
    exportRequest = {
      enqueue: jest
        .fn()
        .mockResolvedValue({ jobId: 'exp_1', status: 'queued' }),
      status: jest.fn(),
      cancel: jest.fn(),
      list: jest.fn(),
      download: jest.fn(),
    };
    authorization = {
      canPerformAction: jest.fn().mockResolvedValue({ allowed: true }),
    };

    service = new DealsService(
      repository,
      dealSettings,
      dealRules,
      // customFieldValidator: pass-through; its own behaviour is covered in its spec.
      { validate: jest.fn((_m: string, v: any) => Promise.resolve(v)) } as any,
      cls as any,
      {
        runWithEvent: jest.fn(async (mutate: any, build: any) => {
          const result = await mutate(undefined);
          const payload = build(result);
          if (payload) await eventEmitter.emitAsync('automation', payload);
          return result;
        }),
      } as any,
      entityAudit,
      { create: jest.fn().mockReturnValue(importStorage) } as any,
      importQueue,
      exportQueue,
      importJobModel,
      // userModel: assertOwnerExists's lookup.
      {
        findOne: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          lean: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue({ _id: 'user_1' }),
        }),
      } as any,
      { find: jest.fn(), countDocuments: jest.fn() } as any, // ticketModel
      exportRequest,
      { validateTagIds: jest.fn().mockResolvedValue(undefined) } as any,
      authorization,
      { getDeniedResourceIds: jest.fn().mockResolvedValue([]) } as any,
      { assertValid: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  describe('create', () => {
    it('should place a deal in the default pipeline when the caller names none', async () => {
      const deal: any = await service.create({ title: 'Website lead' } as any);

      expect(dealSettings.resolvePlacement).toHaveBeenCalledWith({
        pipelineId: undefined,
        stageId: undefined,
      });
      expect(deal.pipelineId).toBe(PIPELINE);
      expect(deal.stageId).toBe(OPEN_STAGE);
      expect(deal.name).toBe('Website lead');
    });

    it("should default probability to the stage's own", async () => {
      const deal: any = await service.create({ title: 'Lead' } as any);
      expect(deal.probability).toBe(20);
    });

    it('should keep an explicit probability', async () => {
      const deal: any = await service.create({
        title: 'Lead',
        probability: 65,
      } as any);
      expect(deal.probability).toBe(65);
    });

    it('should seed the follow-up queue so a new deal owes a touch', async () => {
      const deal: any = await service.create({ title: 'Lead' } as any);
      expect(deal.nextFollowUpAt).toBeInstanceOf(Date);
    });

    it('should record the first stage-history entry', async () => {
      const deal: any = await service.create({ title: 'Lead' } as any);
      expect(deal.stageHistory).toEqual([
        expect.objectContaining({ fromStageId: null, toStageId: OPEN_STAGE }),
      ]);
    });

    it('should refuse creation directly into a closed stage', async () => {
      await expect(
        service.create({ title: 'Lead', stageId: WON_STAGE } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should mark ownership explicit only when the caller chose an owner', async () => {
      const withOwner: any = await service.create({
        title: 'Lead',
        ownerId: 'user_1',
      } as any);
      const withoutOwner: any = await service.create({ title: 'Lead' } as any);

      expect(withOwner.ownerAssignedExplicitly).toBe(true);
      // The create default stamps an owner; leaving the flag false is what lets
      // auto-assignment claim the record.
      expect(withoutOwner.ownerAssignedExplicitly).toBe(false);
    });

    it('should refuse an obvious duplicate unless the caller insists', async () => {
      repository.existsOpenDuplicate.mockResolvedValue(true);

      await expectBusinessCode(
        service.create({ title: 'Lead' } as any),
        DEAL_ERRORS.POSSIBLE_DUPLICATE,
      );

      await expect(
        service.create({ title: 'Lead', allowDuplicate: true } as any),
      ).resolves.toBeDefined();
    });
  });

  describe('update', () => {
    it('should refuse an update whose pre-read finds nothing, and emit no audit', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.update('missing', { title: 'x' })).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.update).not.toHaveBeenCalled();
      expect(entityAudit.emit).not.toHaveBeenCalled();
    });

    it('should emit an audit entry carrying both snapshots', async () => {
      repository.findOne.mockResolvedValue(existingDeal());

      await service.update('deal_1', { title: 'Renamed' });

      expect(entityAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'deal',
          entityId: 'deal_1',
          kind: 'updated',
        }),
      );
    });

    it('should touch lastActivityAt on every edit', async () => {
      repository.findOne.mockResolvedValue(existingDeal());

      await service.update('deal_1', { title: 'Renamed' });

      expect(repository.update.mock.calls[0][1].lastActivityAt).toBeInstanceOf(
        Date,
      );
    });

    it('should re-arm the follow-up sweep when the date is rescheduled', async () => {
      repository.findOne.mockResolvedValue(existingDeal());

      await service.update('deal_1', { nextFollowUpAt: new Date() } as any);

      expect(repository.update.mock.calls[0][1].followUpNotifiedAt).toBeNull();
    });

    it('should require deals:assign to hand a deal to someone else', async () => {
      repository.findOne.mockResolvedValue(existingDeal({ ownerId: 'user_1' }));
      authorization.canPerformAction.mockResolvedValue({ allowed: false });

      await expect(
        service.update('deal_1', { ownerId: 'user_2' } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should clear the unassigned marker on reassignment', async () => {
      repository.findOne.mockResolvedValue(
        existingDeal({ ownerId: null, unassignedReason: 'owner_removed' }),
      );

      await service.update('deal_1', { ownerId: 'user_2' } as any);

      const payload = repository.update.mock.calls[0][1];
      expect(payload.unassignedReason).toBeNull();
      expect(payload.ownerAssignedExplicitly).toBe(true);
    });

    it('should ignore client-supplied close timestamps', async () => {
      repository.findOne.mockResolvedValue(existingDeal());

      await service.update('deal_1', {
        title: 'x',
        wonAt: new Date(),
        lostAt: new Date(),
      } as any);

      const payload = repository.update.mock.calls[0][1];
      expect(payload.wonAt).toBeUndefined();
      expect(payload.lostAt).toBeUndefined();
    });
  });

  describe('stage transitions', () => {
    it('should stamp wonAt and clear the follow-up when a deal is won', async () => {
      repository.findOne.mockResolvedValue(existingDeal());

      await service.update('deal_1', { stageId: WON_STAGE } as any);

      const payload = repository.update.mock.calls[0][1];
      expect(payload.wonAt).toBeInstanceOf(Date);
      expect(payload.lostAt).toBeNull();
      expect(payload.nextFollowUpAt).toBeNull();
    });

    it('should stamp lostAt when a deal is lost with a reason', async () => {
      repository.findOne.mockResolvedValue(existingDeal());

      await service.update('deal_1', {
        stageId: LOST_STAGE,
        lostReason: 'Too expensive',
      } as any);

      expect(repository.update.mock.calls[0][1].lostAt).toBeInstanceOf(Date);
    });

    it('should require a reason to close as Lost', async () => {
      repository.findOne.mockResolvedValue(existingDeal());

      await expect(
        service.update('deal_1', { stageId: LOST_STAGE } as any),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should require deals:move_stage to move between stages', async () => {
      repository.findOne.mockResolvedValue(existingDeal());
      authorization.canPerformAction.mockResolvedValue({ allowed: false });

      await expect(
        service.update('deal_1', { stageId: WON_STAGE } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should refuse a win that leaves the amount at zero', async () => {
      repository.findOne.mockResolvedValue(existingDeal({ value: 0 }));

      await expect(
        service.update('deal_1', { stageId: WON_STAGE } as any),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should refuse a win on an unowned deal', async () => {
      repository.findOne.mockResolvedValue(existingDeal({ ownerId: null }));

      await expect(
        service.update('deal_1', { stageId: WON_STAGE } as any),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should let a tenant that requires a contact block a win without one', async () => {
      dealRules.get.mockResolvedValue({
        ...DEFAULT_DEAL_RULES,
        requireContactOnWin: true,
      });
      repository.findOne.mockResolvedValue(existingDeal({ contactIds: [] }));

      await expect(
        service.update('deal_1', { stageId: WON_STAGE } as any),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should REFUSE to reopen a closed deal without allowReopen', async () => {
      repository.findOne.mockResolvedValue(
        existingDeal({ stageId: WON_STAGE, wonAt: new Date() }),
      );

      await expectBusinessCode(
        service.update('deal_1', { stageId: OPEN_STAGE } as any),
        DEAL_ERRORS.ALREADY_WON,
      );
    });

    it('should refuse a Won → Lost reclassification without allowReopen', async () => {
      repository.findOne.mockResolvedValue(
        existingDeal({ stageId: WON_STAGE, wonAt: new Date() }),
      );

      await expectBusinessCode(
        service.update('deal_1', {
          stageId: LOST_STAGE,
          lostReason: 'Churned',
        } as any),
        DEAL_ERRORS.ALREADY_WON,
      );
    });

    it('should allow an explicit reopen and CLEAR both stamps', async () => {
      repository.findOne.mockResolvedValue(
        existingDeal({ stageId: WON_STAGE, wonAt: new Date() }),
      );

      await service.update('deal_1', {
        stageId: OPEN_STAGE,
        allowReopen: true,
      } as any);

      const payload = repository.update.mock.calls[0][1];
      expect(payload.wonAt).toBeNull();
      expect(payload.lostAt).toBeNull();
    });

    it('should block rewriting a closed deal economics without allowReopen', async () => {
      repository.findOne.mockResolvedValue(
        existingDeal({ stageId: WON_STAGE, wonAt: new Date() }),
      );

      await expectBusinessCode(
        service.update('deal_1', { value: 999 } as any),
        DEAL_ERRORS.ALREADY_WON,
      );
    });

    it('should treat a stage deleted under a closed deal as still closed', async () => {
      dealSettings.describeStage.mockResolvedValue(null);
      repository.findOne.mockResolvedValue(
        existingDeal({ stageId: 'deleted_stage', wonAt: new Date() }),
      );

      await expectBusinessCode(
        service.update('deal_1', { stageId: OPEN_STAGE } as any),
        DEAL_ERRORS.ALREADY_WON,
      );
    });

    it('should ignore a stage echo that is not a move', async () => {
      repository.findOne.mockResolvedValue(existingDeal());

      await service.update('deal_1', {
        stageId: OPEN_STAGE,
        title: 'Renamed',
      } as any);

      expect(repository.appendStageHistory).not.toHaveBeenCalled();
      expect(repository.update.mock.calls[0][1].stageEnteredAt).toBeUndefined();
    });

    it('should append one history entry with the time spent in the old stage', async () => {
      repository.findOne.mockResolvedValue(existingDeal());

      await service.update('deal_1', { stageId: WON_STAGE } as any);

      expect(repository.appendStageHistory).toHaveBeenCalledWith(
        'deal_1',
        expect.objectContaining({
          fromStageId: OPEN_STAGE,
          toStageId: WON_STAGE,
          durationMs: expect.any(Number),
        }),
        undefined,
      );
    });
  });

  describe('bulk', () => {
    it('should report a per-id reason instead of failing the whole request', async () => {
      repository.findOne
        .mockResolvedValueOnce(existingDeal())
        .mockResolvedValueOnce(null);

      const result = await service.bulkUpdate({
        ids: ['deal_1', 'deal_2'],
        stageId: WON_STAGE,
      } as any);

      expect(result.updated).toBe(1);
      expect(result.skipped).toEqual([
        { id: 'deal_2', reason: 'Not found, or outside your access scope.' },
      ]);
    });

    it('should refuse a bulk update that changes nothing', async () => {
      await expect(
        service.bulkUpdate({ ids: ['deal_1'] } as any),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('board', () => {
    it('should count and sum each column in the database, not the browser', async () => {
      repository.boardSummary.mockResolvedValue([
        { stageId: OPEN_STAGE, dealCount: 1200, totalValue: 480_000 },
      ]);

      const board = await service.getBoardSummary({});

      expect(board.pipelineId).toBe(PIPELINE);
      expect(board.columns[0].dealCount).toBe(1200);
    });

    it('should page one column by opaque cursor', async () => {
      repository.findManyByCursor.mockResolvedValue({
        data: [],
        nextCursor: { createdAt: '2026-08-01T00:00:00.000Z', id: 'deal_9' },
      });

      const page = await service.getBoardColumn({ stageId: OPEN_STAGE });

      expect(typeof page.nextCursor).toBe('string');
      expect(page.nextCursor).not.toContain('deal_9'); // opaque, not the raw position
    });
  });

  describe('import validation', () => {
    it('should throw when no file provided', async () => {
      await expect(service.uploadImportFile(null as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw when the file exceeds the size limit', async () => {
      await expect(
        service.uploadImportFile({
          buffer: Buffer.from(''),
          originalname: 'big.csv',
          size: 999 * 1024 * 1024,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should require a title mapping', async () => {
      await expect(
        service.startImport({
          fileKey: 'k.csv',
          mapping: { Amount: 'value' },
        } as any),
      ).rejects.toThrow('mapping must include title');
    });

    it('should reject an unknown mapping target', async () => {
      await expect(
        service.startImport({
          fileKey: 'k.csv',
          mapping: { Name: 'title', Junk: 'nope' },
        } as any),
      ).rejects.toThrow(/Invalid mapping target/);
    });

    it('should reject an unsupported dedup field', async () => {
      await expect(
        service.startImport({
          fileKey: 'k.csv',
          mapping: { Name: 'title' },
          deduplication: { matchingFields: ['phone'], policy: 'skip' },
        } as any),
      ).rejects.toThrow(/Unsupported dedup/);
    });

    it('should carry the default placement to the worker, which has no tenant context', async () => {
      await service.startImport({
        fileKey: 'k.csv',
        mapping: { Name: 'title' },
      } as any);

      expect(importQueue.add).toHaveBeenCalledWith(
        'import',
        expect.objectContaining({
          defaultPipelineId: PIPELINE,
          defaultStageId: OPEN_STAGE,
        }),
      );
    });
  });

  describe('import status', () => {
    it('should throw when the job does not exist', async () => {
      importQueue.getJob.mockResolvedValue(null);
      await expect(service.getImportStatus('nope')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should refuse a job belonging to another tenant', async () => {
      importQueue.getJob.mockResolvedValue({
        data: { tenantId: 'other_tenant', userId: 'user_1' },
        getState: jest.fn(),
      });
      await expect(service.getImportStatus('job_1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
