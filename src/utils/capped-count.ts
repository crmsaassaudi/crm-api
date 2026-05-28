import { FilterQuery, Model } from 'mongoose';

export interface CappedCountResult {
  totalItems: number;
  isExactCount: boolean;
}

/**
 * countDocuments with a hard cap.
 *
 * A full `countDocuments` on a multi-million-document collection takes
 * seconds even with a covered index. Most list UIs only need to know
 * "fewer than N items match" — beyond that, exact count provides no value
 * to the user but linearly costs the DB.
 *
 * Returns up to `countLimit` exactly; if there are more, returns the cap
 * and `isExactCount=false` so the caller (or UI) can render `10000+`.
 */
export async function cappedCount<T>(
  model: Model<T>,
  where: FilterQuery<T>,
  countLimit = 10_000,
): Promise<CappedCountResult> {
  const count = await model
    .countDocuments(where)
    .limit(countLimit + 1)
    .exec();

  if (count > countLimit) {
    return { totalItems: countLimit, isExactCount: false };
  }
  return { totalItems: count, isExactCount: true };
}
