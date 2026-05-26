import { ReportGranularity } from '../dto/base-report-filter.dto';

export interface BucketCount {
  _id: string;
  count: number;
}

export interface MergedGrowthBucket {
  date: string;
  createdCount: number;
  deletedCount: number;
  netGrowth: number;
}

export const getMongoDateFormat = (granularity: ReportGranularity): string => {
  const formats: Record<ReportGranularity, string> = {
    day: '%Y-%m-%d',
    week: '%Y-W%V',
    month: '%Y-%m',
  };

  return formats[granularity];
};

export const parseReportDateRange = (
  fromDate: string,
  toDate: string,
): { from: Date; to: Date } => {
  const from = parseBoundaryDate(fromDate, false);
  const to = parseBoundaryDate(toDate, true);

  return { from, to };
};

export const mergeGrowthBuckets = (
  from: Date,
  to: Date,
  granularity: ReportGranularity,
  created: BucketCount[],
  deleted: BucketCount[],
): MergedGrowthBucket[] => {
  const createdByDate = toCountMap(created);
  const deletedByDate = toCountMap(deleted);
  const keys = new Set([
    ...buildBucketKeys(from, to, granularity),
    ...createdByDate.keys(),
    ...deletedByDate.keys(),
  ]);

  return [...keys].sort().map((date) => {
    const createdCount = createdByDate.get(date) ?? 0;
    const deletedCount = deletedByDate.get(date) ?? 0;

    return {
      date,
      createdCount,
      deletedCount,
      netGrowth: createdCount - deletedCount,
    };
  });
};

const parseBoundaryDate = (value: string, isEnd: boolean): Date => {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = dateOnly
    ? new Date(`${value}T${isEnd ? '23:59:59.999' : '00:00:00.000'}Z`)
    : new Date(value);

  return date;
};

const toCountMap = (rows: BucketCount[]): Map<string, number> =>
  new Map(rows.map((row) => [row._id, row.count]));

const buildBucketKeys = (
  from: Date,
  to: Date,
  granularity: ReportGranularity,
): string[] => {
  const keys: string[] = [];
  const cursor = startOfBucket(from, granularity);

  while (cursor.getTime() <= to.getTime()) {
    keys.push(formatBucketKey(cursor, granularity));
    advanceBucket(cursor, granularity);
  }

  return keys;
};

const startOfBucket = (date: Date, granularity: ReportGranularity): Date => {
  const next = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );

  if (granularity === 'month') {
    next.setUTCDate(1);
  }

  if (granularity === 'week') {
    const day = next.getUTCDay() || 7;
    next.setUTCDate(next.getUTCDate() - day + 1);
  }

  return next;
};

const advanceBucket = (date: Date, granularity: ReportGranularity): void => {
  if (granularity === 'day') {
    date.setUTCDate(date.getUTCDate() + 1);
    return;
  }

  if (granularity === 'week') {
    date.setUTCDate(date.getUTCDate() + 7);
    return;
  }

  date.setUTCMonth(date.getUTCMonth() + 1);
};

const formatBucketKey = (
  date: Date,
  granularity: ReportGranularity,
): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  if (granularity === 'day') return `${year}-${month}-${day}`;
  if (granularity === 'month') return `${year}-${month}`;

  return `${year}-W${String(getIsoWeek(date)).padStart(2, '0')}`;
};

const getIsoWeek = (date: Date): number => {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));

  return Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
};
