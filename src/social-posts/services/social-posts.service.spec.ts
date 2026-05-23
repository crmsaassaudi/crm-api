import { BadRequestException } from '@nestjs/common';
import { SocialContentAssetsService } from './social-posts.service';

describe('SocialContentAssetsService', () => {
  const tenantId = 'tenant_1';
  const userId = 'user_1';
  const now = new Date('2026-05-23T10:00:00.000Z');

  const createAsset = (overrides: Record<string, any> = {}) => ({
    id: 'asset_1',
    tenantId,
    title: 'Launch asset',
    status: 'ACTIVE',
    createdById: userId,
    latestVersionId: 'version_1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  const createVersion = (overrides: Record<string, any> = {}) => ({
    id: 'version_1',
    tenantId,
    assetId: 'asset_1',
    versionNumber: 1,
    content: 'Base copy',
    mediaUrls: [],
    aiVideoJobIds: [],
    mediaType: 'text',
    approvalStatus: 'PENDING',
    savedById: userId,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  const createPublication = (overrides: Record<string, any> = {}) => ({
    id: 'publication_1',
    tenantId,
    assetId: 'asset_1',
    sourceVersionId: 'version_1',
    publicationGroupId: 'group_1',
    channelId: 'channel_1',
    channelName: 'Facebook Page',
    channelAccount: 'page_1',
    platform: 'facebook',
    snapshot: {
      content: 'Snapshot copy',
      mediaUrls: [],
      aiVideoJobIds: [],
      mediaType: 'text',
    },
    status: 'PENDING',
    retryCount: 0,
    maxRetries: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  let assetRepository: Record<string, jest.Mock>;
  let publicationRepository: Record<string, jest.Mock>;
  let versionRepository: Record<string, jest.Mock>;
  let channelRepository: Record<string, jest.Mock>;
  let publisherRegistry: Record<string, jest.Mock>;
  let queueProducer: Record<string, jest.Mock>;
  let aiVideoJobService: Record<string, jest.Mock>;
  let auditLogService: Record<string, jest.Mock>;
  let cls: Record<string, jest.Mock>;
  let service: SocialContentAssetsService;

  beforeEach(() => {
    assetRepository = {
      create: jest.fn(),
      update: jest.fn(),
      findById: jest.fn(),
      findPaginated: jest.fn(),
      archive: jest.fn(),
    };
    publicationRepository = {
      createMany: jest.fn(),
      findByAssetId: jest.fn().mockResolvedValue([]),
      findById: jest.fn(),
      findPaginated: jest.fn(),
      update: jest.fn(),
      updateStatus: jest.fn(),
      incrementRetry: jest.fn(),
      resetForRetry: jest.fn(),
    };
    versionRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByAssetId: jest.fn(),
      findLatestByAssetId: jest.fn(),
      getNextVersionNumber: jest.fn(),
      update: jest.fn(),
    };
    channelRepository = {
      findByIdWithCredentials: jest.fn(),
      update: jest.fn(),
    };
    publisherRegistry = {
      get: jest.fn(),
    };
    queueProducer = {
      schedule: jest.fn(),
      cancel: jest.fn(),
    };
    aiVideoJobService = {
      resolveApprovedVideoUrls: jest.fn(),
    };
    auditLogService = {
      record: jest.fn(),
    };
    cls = {
      get: jest.fn((key: string) => {
        if (key === 'tenantId') return tenantId;
        if (key === 'userId') return userId;
        return undefined;
      }),
    };

    service = new SocialContentAssetsService(
      assetRepository as any,
      publicationRepository as any,
      versionRepository as any,
      channelRepository as any,
      publisherRegistry as any,
      queueProducer as any,
      aiVideoJobService as any,
      auditLogService as any,
      cls as any,
    );
  });

  it('should create an asset with version 1 pending approval', async () => {
    const asset = createAsset({ latestVersionId: undefined });
    const updatedAsset = createAsset();
    const version = createVersion();
    assetRepository.create.mockResolvedValue(asset);
    versionRepository.create.mockResolvedValue(version);
    assetRepository.update.mockResolvedValue(updatedAsset);

    const result = await service.create({
      title: 'Launch asset',
      content: 'Base copy',
    });

    expect(assetRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        title: 'Launch asset',
        status: 'ACTIVE',
      }),
    );
    expect(versionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'asset_1',
        versionNumber: 1,
        approvalStatus: 'PENDING',
        content: 'Base copy',
      }),
    );
    expect(result.latestVersion?.id).toBe('version_1');
  });

  it('should create a new pending version without mutating existing publication snapshots', async () => {
    const oldPublication = createPublication({
      snapshot: {
        content: 'Old locked copy',
        mediaUrls: [],
        aiVideoJobIds: [],
        mediaType: 'text',
      },
    });
    const newVersion = createVersion({
      id: 'version_2',
      versionNumber: 2,
      content: 'Updated master copy',
    });
    assetRepository.findById.mockResolvedValue(createAsset());
    versionRepository.findLatestByAssetId.mockResolvedValue(createVersion());
    versionRepository.getNextVersionNumber.mockResolvedValue(2);
    versionRepository.create.mockResolvedValue(newVersion);
    assetRepository.update.mockResolvedValue(
      createAsset({ latestVersionId: 'version_2' }),
    );
    publicationRepository.findByAssetId.mockResolvedValue([oldPublication]);

    const result = await service.update('asset_1', {
      content: 'Updated master copy',
    });

    expect(versionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        versionNumber: 2,
        content: 'Updated master copy',
        approvalStatus: 'PENDING',
      }),
    );
    expect(publicationRepository.update).not.toHaveBeenCalled();
    expect(result.publications?.[0].snapshot.content).toBe('Old locked copy');
  });

  it('should reject publication creation when the selected version is not approved', async () => {
    assetRepository.findById.mockResolvedValue(createAsset());
    versionRepository.findLatestByAssetId.mockResolvedValue(createVersion());

    await expect(
      service.createPublications('asset_1', {
        channelIds: ['channel_1'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(publicationRepository.createMany).not.toHaveBeenCalled();
    expect(queueProducer.schedule).not.toHaveBeenCalled();
  });

  it('should create independent publication snapshots from approved versions and overrides', async () => {
    const facebookPublisher = { validateContentLimits: jest.fn() };
    const instagramPublisher = { validateContentLimits: jest.fn() };
    assetRepository.findById.mockResolvedValue(createAsset());
    versionRepository.findLatestByAssetId.mockResolvedValue(
      createVersion({ approvalStatus: 'APPROVED' }),
    );
    channelRepository.findByIdWithCredentials.mockImplementation(
      (_tenantId: string, channelId: string) =>
        Promise.resolve(
          channelId === 'channel_1'
            ? {
                id: 'channel_1',
                name: 'Facebook Page',
                account: 'page_1',
                type: 'facebook',
                status: 'Connected',
              }
            : {
                id: 'channel_2',
                name: 'Instagram Account',
                account: 'ig_1',
                type: 'instagram',
                status: 'Connected',
              },
        ),
    );
    publisherRegistry.get.mockImplementation((platform: string) =>
      platform === 'facebook' ? facebookPublisher : instagramPublisher,
    );
    publicationRepository.createMany.mockImplementation((items: any[]) =>
      Promise.resolve(
        items.map((item, index) =>
          createPublication({
            ...item,
            id: `publication_${index + 1}`,
          }),
        ),
      ),
    );

    const result = await service.createPublications('asset_1', {
      channelIds: ['channel_1', 'channel_2'],
      overrides: [
        {
          channelId: 'channel_1',
          content: 'Facebook-local copy',
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0].snapshot.content).toBe('Facebook-local copy');
    expect(result[1].snapshot.content).toBe('Base copy');
    expect(queueProducer.schedule).toHaveBeenCalledTimes(2);
    expect(facebookPublisher.validateContentLimits).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Facebook-local copy' }),
    );
  });
});
