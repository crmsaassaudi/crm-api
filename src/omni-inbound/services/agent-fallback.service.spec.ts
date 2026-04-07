import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgentFallbackService } from './agent-fallback.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { AssignmentService } from './assignment.service';
import { AgentPresenceService } from './agent-presence.service';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

describe('AgentFallbackService', () => {
  let service: AgentFallbackService;
  let conversationRepoMock: any;
  let assignmentServiceMock: any;
  let presenceServiceMock: any;
  let settingsServiceMock: any;
  let eventEmitterMock: any;
  let redisMock: any;

  beforeEach(async () => {
    conversationRepoMock = {
      findOpenByAgent: jest.fn().mockResolvedValue([]),
      updateAssignment: jest.fn().mockResolvedValue(undefined),
    };

    assignmentServiceMock = {
      assignConversation: jest.fn().mockResolvedValue('new_agent_1'),
    };

    presenceServiceMock = {
      getPresence: jest.fn().mockResolvedValue(null), // agent is offline
    };

    settingsServiceMock = {
      getSetting: jest.fn().mockResolvedValue({
        enabled: true,
        timeoutMinutes: 3,
        strategy: 'back-to-queue',
        notifyAgent: true,
      }),
    };

    eventEmitterMock = {
      emit: jest.fn(),
    };

    redisMock = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(new Date().toISOString()), // still disconnected
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentFallbackService,
        { provide: ConversationRepository, useValue: conversationRepoMock },
        { provide: AssignmentService, useValue: assignmentServiceMock },
        { provide: AgentPresenceService, useValue: presenceServiceMock },
        { provide: CrmSettingsService, useValue: settingsServiceMock },
        { provide: EventEmitter2, useValue: eventEmitterMock },
        { provide: IOREDIS_CLIENT, useValue: redisMock },
      ],
    }).compile();

    service = module.get<AgentFallbackService>(AgentFallbackService);
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Configuration Reading
  // ────────────────────────────────────────────────────────────────────────

  describe('reads config from settings', () => {
    it('should read auto-reassignment settings on disconnect', async () => {
      jest.useFakeTimers();

      await service.onAgentDisconnected('tenant_1', 'agent_1');

      expect(settingsServiceMock.getSetting).toHaveBeenCalledWith(
        'omni_auto_reassignment',
        'tenant_1',
      );

      jest.useRealTimers();
    });

    it('should skip reassignment when disabled in settings', async () => {
      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: false,
        timeoutMinutes: 3,
        strategy: 'back-to-queue',
        notifyAgent: true,
      });

      await service.onAgentDisconnected('tenant_1', 'agent_1');

      // Should not set Redis marker or schedule timer
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('should use custom timeout from settings', async () => {
      jest.useFakeTimers();

      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 5,
        strategy: 'next-available',
        notifyAgent: false,
      });

      await service.onAgentDisconnected('tenant_1', 'agent_1');

      // TTL should be (5 * 60) + 60 = 360 seconds
      expect(redisMock.set).toHaveBeenCalledWith(
        expect.stringContaining('agent_1'),
        expect.any(String),
        'EX',
        360,
      );

      jest.useRealTimers();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Reassignment Execution
  // ────────────────────────────────────────────────────────────────────────

  describe('reassignment after timeout', () => {
    it('should reassign conversations when agent stays offline', async () => {
      jest.useFakeTimers();

      conversationRepoMock.findOpenByAgent.mockResolvedValue([
        { id: 'conv_1' },
        { id: 'conv_2' },
      ]);

      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 1,
        strategy: 'next-available',
        notifyAgent: true,
      });

      await service.onAgentDisconnected('tenant_1', '507f1f77bcf86cd799439011');

      // Fast-forward past the timeout
      jest.advanceTimersByTime(1 * 60 * 1000 + 100);

      // Wait for async operations
      await jest.runAllTimersAsync();

      expect(conversationRepoMock.findOpenByAgent).toHaveBeenCalledWith(
        'tenant_1',
        '507f1f77bcf86cd799439011',
      );

      jest.useRealTimers();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Agent Reconnection
  // ────────────────────────────────────────────────────────────────────────

  describe('agent reconnection', () => {
    it('should cancel reassignment when agent reconnects', async () => {
      jest.useFakeTimers();

      await service.onAgentDisconnected('tenant_1', 'agent_1');
      await service.onAgentReconnected('tenant_1', 'agent_1');

      expect(redisMock.del).toHaveBeenCalledWith(
        expect.stringContaining('agent_1'),
      );

      // Advance past timeout — no reassignment should happen
      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(conversationRepoMock.findOpenByAgent).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should skip reassignment if agent reconnected before check', async () => {
      // Agent reconnected — Redis marker cleared
      redisMock.get.mockResolvedValue(null);

      jest.useFakeTimers();

      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 1,
        strategy: 'back-to-queue',
        notifyAgent: true,
      });

      await service.onAgentDisconnected('tenant_1', '507f1f77bcf86cd799439011');

      jest.advanceTimersByTime(1 * 60 * 1000 + 100);
      await jest.runAllTimersAsync();

      // Should not attempt to find conversations since agent reconnected
      expect(conversationRepoMock.findOpenByAgent).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should skip reassignment if presence is active', async () => {
      presenceServiceMock.getPresence.mockResolvedValue({ status: 'online' });

      jest.useFakeTimers();

      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 1,
        strategy: 'back-to-queue',
        notifyAgent: true,
      });

      await service.onAgentDisconnected('tenant_1', '507f1f77bcf86cd799439011');

      jest.advanceTimersByTime(1 * 60 * 1000 + 100);
      await jest.runAllTimersAsync();

      expect(conversationRepoMock.findOpenByAgent).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Strategy Mapping
  // ────────────────────────────────────────────────────────────────────────

  describe('strategy mapping', () => {
    it('should use "back-to-queue" strategy by unassigning', async () => {
      jest.useFakeTimers();

      conversationRepoMock.findOpenByAgent.mockResolvedValue([
        { id: 'conv_1' },
      ]);

      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 1,
        strategy: 'back-to-queue',
        notifyAgent: true,
      });

      await service.onAgentDisconnected('tenant_1', '507f1f77bcf86cd799439011');

      jest.advanceTimersByTime(1 * 60 * 1000 + 100);
      await jest.runAllTimersAsync();

      // back-to-queue should call updateAssignment with null, NOT assignConversation
      expect(conversationRepoMock.updateAssignment).toHaveBeenCalled();
      expect(assignmentServiceMock.assignConversation).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should use "next-available" strategy by calling round-robin', async () => {
      jest.useFakeTimers();

      conversationRepoMock.findOpenByAgent.mockResolvedValue([
        { id: 'conv_1' },
      ]);

      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 1,
        strategy: 'next-available',
        notifyAgent: true,
      });

      await service.onAgentDisconnected('tenant_1', '507f1f77bcf86cd799439011');

      jest.advanceTimersByTime(1 * 60 * 1000 + 100);
      await jest.runAllTimersAsync();

      expect(assignmentServiceMock.assignConversation).toHaveBeenCalledWith(
        'tenant_1',
        'conv_1',
        'round-robin',
      );

      jest.useRealTimers();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ────────────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should skip invalid ObjectId agents', async () => {
      jest.useFakeTimers();

      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 1,
        strategy: 'back-to-queue',
        notifyAgent: true,
      });

      // Use a non-ObjectId agentId (like a UUID)
      await service.onAgentDisconnected('tenant_1', 'not-a-valid-objectid');

      jest.advanceTimersByTime(1 * 60 * 1000 + 100);
      await jest.runAllTimersAsync();

      // Should skip — agent ID not valid for MongoDB query
      expect(conversationRepoMock.findOpenByAgent).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should handle no open conversations gracefully', async () => {
      jest.useFakeTimers();

      conversationRepoMock.findOpenByAgent.mockResolvedValue([]);

      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 1,
        strategy: 'back-to-queue',
        notifyAgent: true,
      });

      await service.onAgentDisconnected('tenant_1', '507f1f77bcf86cd799439011');

      jest.advanceTimersByTime(1 * 60 * 1000 + 100);
      await jest.runAllTimersAsync();

      expect(assignmentServiceMock.assignConversation).not.toHaveBeenCalled();
      expect(redisMock.del).toHaveBeenCalled(); // cleanup marker

      jest.useRealTimers();
    });

    it('should use defaults when settings service throws', async () => {
      jest.useFakeTimers();

      settingsServiceMock.getSetting.mockRejectedValue(new Error('DB down'));

      await service.onAgentDisconnected('tenant_1', 'agent_1');

      // Should still schedule with default timeout (3 minutes)
      expect(redisMock.set).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'EX',
        240, // (3 * 60) + 60
      );

      jest.useRealTimers();
    });
  });
});
