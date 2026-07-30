import { AgentPresenceService } from './agent-presence.service';

describe('AgentPresenceService weighted capacity', () => {
  let client: any;
  let service: AgentPresenceService;

  beforeEach(() => {
    client = {
      eval: jest.fn(),
      setex: jest.fn(),
    };
    service = new AgentPresenceService({
      getClient: () => client,
    } as any);
  });

  it('should passes workload units into atomic claim and release scripts', async () => {
    client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(null);

    await expect(
      service.claimIfUnderCapacity('tenant_1', 'agent_1', 5),
    ).resolves.toBe(true);
    await service.releaseConversation('tenant_1', 'agent_1', 5);

    expect(client.eval.mock.calls[0].slice(-2)).toEqual(['agent_1', '5']);
    expect(client.eval.mock.calls[1].slice(-2)).toEqual(['agent_1', '5']);
  });

  it('should passes fractional units into candidate reservation', async () => {
    client.eval.mockResolvedValue('agent_1');

    await service.reserveFirstEligibleAgent(
      'tenant_1',
      ['agent_1', 'agent_2'],
      1.5,
    );

    expect(client.eval.mock.calls[0].at(-1)).toBe('1.5');
  });
});
