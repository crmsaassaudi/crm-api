export interface SearchHighlightRange {
  start: number;
  end: number;
}

export interface SearchRanking {
  score: number;
  highlights: {
    title?: SearchHighlightRange[];
    subtitle?: SearchHighlightRange[];
  };
}

const normalize = (value: string): string =>
  value.normalize('NFKD').toLocaleLowerCase().trim();

const rangesFor = (
  value: string,
  normalizedQuery: string,
): SearchHighlightRange[] => {
  if (!value || !normalizedQuery) return [];
  const normalizedValue = normalize(value);
  const ranges: SearchHighlightRange[] = [];
  let from = 0;
  while (ranges.length < 5) {
    const index = normalizedValue.indexOf(normalizedQuery, from);
    if (index < 0) break;
    ranges.push({ start: index, end: index + normalizedQuery.length });
    from = index + Math.max(1, normalizedQuery.length);
  }
  return ranges;
};

const fieldScore = (value: string, query: string): number => {
  const normalizedValue = normalize(value);
  if (!normalizedValue) return 0;
  if (normalizedValue === query) return 1;
  if (normalizedValue.startsWith(query)) return 0.9;
  if (normalizedValue.split(/\s+/).some((token) => token.startsWith(query))) {
    return 0.78;
  }
  if (normalizedValue.includes(query)) return 0.62;
  return 0;
};

export const rankSearchResult = (
  query: string,
  title: string,
  subtitle = '',
): SearchRanking => {
  const normalizedQuery = normalize(query);
  const titleScore = fieldScore(title, normalizedQuery);
  const subtitleScore = fieldScore(subtitle, normalizedQuery) * 0.45;
  const titleRanges = rangesFor(title, normalizedQuery);
  const subtitleRanges = rangesFor(subtitle, normalizedQuery);

  return {
    score: Number(Math.max(titleScore, subtitleScore).toFixed(4)),
    highlights: {
      ...(titleRanges.length > 0 ? { title: titleRanges } : {}),
      ...(subtitleRanges.length > 0 ? { subtitle: subtitleRanges } : {}),
    },
  };
};
