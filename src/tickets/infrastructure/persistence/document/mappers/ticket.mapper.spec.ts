import { TicketMapper } from './ticket.mapper';
import { Ticket } from '../../../../domain/ticket';

/**
 * The mapper is the whitelist.
 *
 * `BaseDocumentRepository.update` writes only what `toPersistence` emits, so a field the
 * mapper does not know about cannot be updated — the write returns 200 and the value is
 * dropped. This is the second time that has bitten: the account identity keys, and then
 * `dealId`, where the ticket↔deal link was inert at three layers at once (missing from
 * the schema, missing from the mapper, and ignored by the list filter).
 */
describe('TicketMapper — dealId round trip', () => {
  const domain = (overrides: Partial<Ticket> = {}): Ticket =>
    ({
      id: '60d0fe4f5311236168a109ca',
      tenantId: '60d0fe4f5311236168a109cc',
      subject: 'Printer on fire',
      ...overrides,
    }) as Ticket;

  it('should carry a dealId to persistence', () => {
    const persisted = TicketMapper.toPersistence(
      domain({ dealId: '60d0fe4f5311236168a109cb' }),
    );
    expect(persisted.dealId).toBe('60d0fe4f5311236168a109cb');
  });

  it('should carry an explicit null, so unlinking is not a silent no-op', () => {
    // `unlinkDeal` writes `dealId: null`. A truthy check in the mapper would drop it and
    // leave the ticket linked while the API reported success.
    const persisted = TicketMapper.toPersistence(
      domain({ dealId: null } as any),
    );
    expect(persisted.dealId).toBeNull();
  });

  it('should omit dealId when the caller did not mention it', () => {
    // A PATCH that only changes the subject must not clear the link.
    const persisted = TicketMapper.toPersistence(domain());
    expect('dealId' in (persisted as any)).toBe(false);
  });

  it('should read dealId back out', () => {
    const mapped = TicketMapper.toDomain({
      _id: '60d0fe4f5311236168a109ca',
      subject: 'Printer on fire',
      dealId: '60d0fe4f5311236168a109cb',
    } as any);
    expect(mapped.dealId).toBe('60d0fe4f5311236168a109cb');
  });

  it('should leave dealId undefined when the document has none', () => {
    const mapped = TicketMapper.toDomain({
      _id: '60d0fe4f5311236168a109ca',
      subject: 'Printer on fire',
    } as any);
    expect(mapped.dealId).toBeUndefined();
  });

  it('should preserve a null dealId in the unlink response', () => {
    const mapped = TicketMapper.toDomain({
      _id: '60d0fe4f5311236168a109ca',
      subject: 'Printer on fire',
      dealId: null,
    } as any);
    expect(mapped.dealId).toBeNull();
  });

  it('should round-trip SLA pause state used by pause and resume commands', () => {
    const pausedAt = new Date('2026-08-01T10:00:00Z');
    const resumedAt = new Date('2026-08-01T10:05:00Z');
    const mapped = TicketMapper.toDomain({
      _id: '60d0fe4f5311236168a109ca',
      subject: 'Printer on fire',
      slaPausedAt: pausedAt,
      slaResumedAt: resumedAt,
      slaPausedSeconds: 300,
    } as any);
    expect(mapped).toEqual(
      expect.objectContaining({
        slaPausedAt: pausedAt,
        slaResumedAt: resumedAt,
        slaPausedSeconds: 300,
      }),
    );

    const persisted = TicketMapper.toPersistence(mapped);
    expect(persisted).toEqual(
      expect.objectContaining({
        slaPausedAt: pausedAt,
        slaResumedAt: resumedAt,
        slaPausedSeconds: 300,
      }),
    );
  });
});
