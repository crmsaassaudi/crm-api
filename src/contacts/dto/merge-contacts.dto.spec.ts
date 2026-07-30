import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MergeContactsDto } from './merge-contacts.dto';

const check = async (payload: unknown) =>
  validate(plainToInstance(MergeContactsDto, payload));

describe('MergeContactsDto', () => {
  it('should accept an empty body (the default single-click merge)', async () => {
    expect(await check({})).toHaveLength(0);
  });

  it('should accept valid per-field winners', async () => {
    expect(
      await check({ fieldWinners: { firstName: 'merged', title: 'survivor' } }),
    ).toHaveLength(0);
  });

  it('should reject a non-object fieldWinners', async () => {
    expect((await check({ fieldWinners: 'merged' })).length).toBeGreaterThan(0);
  });

  it('should reject a winner outside survivor|merged', async () => {
    // If this ever regresses to passing, an unrecognised value falls through to
    // the default survivorship rule rather than doing anything unsafe — but the
    // caller deserves the 422 rather than silently different behaviour.
    expect(
      (await check({ fieldWinners: { firstName: 'whoever' } })).length,
    ).toBeGreaterThan(0);
  });
});
