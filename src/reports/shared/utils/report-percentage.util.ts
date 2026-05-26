export const safePercent = (part: number, total: number): number =>
  total > 0 ? Math.round((part / total) * 100) : 100;
