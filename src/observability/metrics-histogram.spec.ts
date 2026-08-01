import { MetricsService } from './metrics.service';

const scrape = (service: MetricsService): string[] =>
  service.toPrometheus().split('\n');

const seriesValue = (lines: string[], prefix: string): number | undefined => {
  const line = lines.find((entry) => entry.startsWith(prefix));
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : undefined;
};

describe('MetricsService.observeHistogram', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('should expose cumulative buckets, a sum and a count', () => {
    metrics.observeHistogram('crm_search_duration_ms', { engine: 'os' }, 30);
    metrics.observeHistogram('crm_search_duration_ms', { engine: 'os' }, 150);

    const lines = scrape(metrics);
    // 30ms falls in ≤50 and every wider bucket; 150ms only from ≤200 up.
    expect(
      seriesValue(lines, 'crm_search_duration_ms_bucket{engine="os",le="25"}'),
    ).toBe(0);
    expect(
      seriesValue(lines, 'crm_search_duration_ms_bucket{engine="os",le="50"}'),
    ).toBe(1);
    expect(
      seriesValue(lines, 'crm_search_duration_ms_bucket{engine="os",le="200"}'),
    ).toBe(2);
    expect(seriesValue(lines, 'crm_search_duration_ms_sum{engine="os"}')).toBe(
      180,
    );
    expect(
      seriesValue(lines, 'crm_search_duration_ms_count{engine="os"}'),
    ).toBe(2);
  });

  it('should emit a +Inf bucket equal to the count', () => {
    // Without this, histogram_quantile() returns NaN and every p95 alert built
    // on the metric silently never fires.
    metrics.observeHistogram('latency_ms', {}, 10_000);
    const lines = scrape(metrics);
    expect(seriesValue(lines, 'latency_ms_bucket{le="+Inf"}')).toBe(1);
    expect(seriesValue(lines, 'latency_ms_count{}')).toBe(1);
  });

  it('should declare the metric as a histogram', () => {
    metrics.observeHistogram('latency_ms', {}, 5);
    expect(scrape(metrics)).toContain('# TYPE latency_ms histogram');
  });

  it('should keep the boundaries a series was created with', () => {
    // A caller that passes different buckets for the same metric must not
    // corrupt a series already being scraped — Prometheus cannot merge series
    // whose boundaries differ.
    metrics.observeHistogram('latency_ms', {}, 5, [10, 100]);
    metrics.observeHistogram('latency_ms', {}, 5, [1, 2, 3]);
    const lines = scrape(metrics);
    expect(seriesValue(lines, 'latency_ms_bucket{le="10"}')).toBe(2);
    expect(seriesValue(lines, 'latency_ms_bucket{le="1"}')).toBeUndefined();
  });

  it('should ignore negative and non-finite observations', () => {
    metrics.observeHistogram('latency_ms', {}, -1);
    metrics.observeHistogram('latency_ms', {}, Number.NaN);
    expect(metrics.toPrometheus()).not.toContain('latency_ms_count');
  });

  it('should keep counters and gauges working alongside histograms', () => {
    metrics.incrementCounter('things_total', { kind: 'a' }, 3);
    metrics.setGauge('depth', { queue: 'q' }, 7);
    metrics.observeHistogram('latency_ms', {}, 5);
    const lines = scrape(metrics);
    expect(seriesValue(lines, 'things_total{kind="a"}')).toBe(3);
    expect(seriesValue(lines, 'depth{queue="q"}')).toBe(7);
    expect(seriesValue(lines, 'latency_ms_count{}')).toBe(1);
  });
});
