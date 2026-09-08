import {
  Counter,
  createBridgeMetrics,
  escapeHelp,
  escapeLabelValue,
  formatLabels,
  formatValue,
  Gauge,
  Histogram,
  MetricsRegistry,
} from './registry';

/** Parses an exposition into lines, dropping blanks — the unit most assertions want. */
const linesOf = (text: string): string[] => text.split('\n').filter((l) => l.length > 0);

describe('escaping', () => {
  it('escapes backslash, quote and newline in a label value', () => {
    expect(escapeLabelValue('a\\b')).toBe('a\\\\b');
    expect(escapeLabelValue('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeLabelValue('one\ntwo')).toBe('one\\ntwo');
  });

  it('escapes the backslash first, so its own escape is not re-escaped', () => {
    // A naive implementation that escapes quotes first turns `\"` into `\\\"` — wrong.
    expect(escapeLabelValue('\\"')).toBe('\\\\\\"');
  });

  it('leaves quotes alone in help text, where they are legal', () => {
    expect(escapeHelp('the "cache" directory')).toBe('the "cache" directory');
    expect(escapeHelp('a\\b')).toBe('a\\\\b');
    expect(escapeHelp('one\ntwo')).toBe('one\\ntwo');
  });
});

describe('formatValue', () => {
  it('uses the exposition spellings for non-finite values', () => {
    // `String(Infinity)` is "Infinity", which a scraper rejects.
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('+Inf');
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe('-Inf');
    expect(formatValue(Number.NaN)).toBe('NaN');
  });

  it('passes ordinary numbers through', () => {
    expect(formatValue(0)).toBe('0');
    expect(formatValue(1.5)).toBe('1.5');
  });
});

describe('formatLabels', () => {
  it('renders nothing when there are no labels', () => {
    expect(formatLabels({})).toBe('');
  });

  it('sorts labels so a series renders identically between scrapes', () => {
    expect(formatLabels({ b: '2', a: '1' })).toBe('{a="1",b="2"}');
  });

  it('escapes label values', () => {
    expect(formatLabels({ path: 'C:\\PGM' })).toBe('{path="C:\\\\PGM"}');
  });
});

describe('Counter', () => {
  it('accumulates', () => {
    const counter = new Counter('tnc_test_total', 'help');
    counter.inc();
    counter.inc(4);
    expect(counter.get()).toBe(5);
  });

  it('keeps label sets apart', () => {
    const counter = new Counter('tnc_test_total', 'help');
    counter.inc(1, { direction: 'pull' });
    counter.inc(2, { direction: 'push' });

    expect(counter.get({ direction: 'pull' })).toBe(1);
    expect(counter.get({ direction: 'push' })).toBe(2);
  });

  it('refuses to decrease', () => {
    const counter = new Counter('tnc_test_total', 'help');
    // A counter that can go down breaks every rate() built on it, and the damage shows
    // up as a wrong graph rather than an error — so it is refused at the call site.
    expect(() => counter.inc(-1)).toThrow(/cannot decrease/);
  });

  it('reports zero before its first observation', () => {
    const counter = new Counter('tnc_test_total', 'help');
    // The series must exist before the first increment, or the scrape after one looks
    // like a counter reset.
    expect(counter.snapshot()).toEqual([
      { name: 'tnc_test_total', type: 'counter', help: 'help', labels: {}, value: 0 },
    ]);
  });

  it('rejects an invalid metric name', () => {
    expect(() => new Counter('not-a-valid-name', 'help')).toThrow(/Invalid metric name/);
  });

  it('rejects an invalid label name', () => {
    const counter = new Counter('tnc_test_total', 'help');
    expect(() => counter.inc(1, { 'not-valid': 'x' })).toThrow(/Invalid label name/);
  });
});

describe('Gauge', () => {
  it('goes up and down', () => {
    const gauge = new Gauge('tnc_test', 'help');
    gauge.set(10);
    gauge.inc(5);
    gauge.dec(3);
    expect(gauge.get()).toBe(12);
  });

  it('tracks label sets independently', () => {
    const gauge = new Gauge('tnc_test', 'help');
    gauge.set(1, { share: 'a' });
    gauge.set(2, { share: 'b' });
    expect(gauge.get({ share: 'a' })).toBe(1);
    expect(gauge.get({ share: 'b' })).toBe(2);
  });
});

describe('Histogram', () => {
  it('produces cumulative buckets ending at +Inf', () => {
    const histogram = new Histogram('tnc_test_seconds', 'help', [1, 5, 10]);
    histogram.observe(0.5);
    histogram.observe(3);
    histogram.observe(7);
    histogram.observe(100);

    const [snapshot] = histogram.snapshot();
    expect(snapshot?.buckets).toEqual([
      { le: 1, count: 1 },
      { le: 5, count: 2 },
      { le: 10, count: 3 },
      { le: Number.POSITIVE_INFINITY, count: 4 },
    ]);
  });

  it('makes +Inf equal the total count, including values past every boundary', () => {
    const histogram = new Histogram('tnc_test_seconds', 'help', [1]);
    histogram.observe(1000);

    const [snapshot] = histogram.snapshot();
    expect(snapshot?.count).toBe(1);
    expect(snapshot?.buckets?.at(-1)).toEqual({ le: Number.POSITIVE_INFINITY, count: 1 });
    // The value exceeded every finite boundary, so only +Inf counts it.
    expect(snapshot?.buckets?.[0]).toEqual({ le: 1, count: 0 });
  });

  it('sums the observations', () => {
    const histogram = new Histogram('tnc_test_seconds', 'help', [10]);
    histogram.observe(1.5);
    histogram.observe(2.5);

    expect(histogram.snapshot()[0]?.sum).toBe(4);
  });

  it('sorts boundaries given out of order', () => {
    const histogram = new Histogram('tnc_test_seconds', 'help', [10, 1, 5]);
    expect(histogram.boundaries).toEqual([1, 5, 10]);
  });

  it('counts a value exactly on a boundary in that bucket', () => {
    // Buckets are `le` — less than *or equal*.
    const histogram = new Histogram('tnc_test_seconds', 'help', [1, 2]);
    histogram.observe(1);
    expect(histogram.snapshot()[0]?.buckets?.[0]).toEqual({ le: 1, count: 1 });
  });
});

describe('MetricsRegistry', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it('returns the same instrument for a repeated registration', () => {
    const a = registry.counter('tnc_test_total', 'help');
    const b = registry.counter('tnc_test_total', 'help');
    a.inc(3);
    // A second instance would silently split the series in two.
    expect(b.get()).toBe(3);
  });

  it('refuses to reuse a name with a different type', () => {
    registry.counter('tnc_test_total', 'help');
    expect(() => registry.gauge('tnc_test_total', 'help')).toThrow(/different type/);
  });

  describe('render', () => {
    it('emits HELP and TYPE exactly once per family', () => {
      const counter = registry.counter('tnc_sync_files_total', 'Files synced.');
      counter.inc(1, { direction: 'pull' });
      counter.inc(2, { direction: 'push' });

      const output = registry.render();
      const helpLines = linesOf(output).filter((l) => l.startsWith('# HELP'));
      const typeLines = linesOf(output).filter((l) => l.startsWith('# TYPE'));

      // Repeating these per labelled child is a parse error in strict scrapers.
      expect(helpLines).toHaveLength(1);
      expect(typeLines).toHaveLength(1);
      expect(helpLines[0]).toBe('# HELP tnc_sync_files_total Files synced.');
      expect(typeLines[0]).toBe('# TYPE tnc_sync_files_total counter');
    });

    it('places HELP and TYPE before the samples of their family', () => {
      registry.counter('tnc_a_total', 'A.').inc();
      registry.gauge('tnc_b', 'B.').set(1);

      const lines = linesOf(registry.render());
      const helpIndex = lines.indexOf('# HELP tnc_b B.');
      const sampleIndex = lines.indexOf('tnc_b 1');
      expect(helpIndex).toBeGreaterThanOrEqual(0);
      expect(sampleIndex).toBeGreaterThan(helpIndex);
    });

    it('renders a histogram as buckets, sum and count', () => {
      const histogram = registry.histogram('tnc_dur_seconds', 'Durations.', [1, 5]);
      histogram.observe(0.5);
      histogram.observe(3);

      const lines = linesOf(registry.render());

      expect(lines).toContain('tnc_dur_seconds_bucket{le="1"} 1');
      expect(lines).toContain('tnc_dur_seconds_bucket{le="5"} 2');
      expect(lines).toContain('tnc_dur_seconds_bucket{le="+Inf"} 2');
      expect(lines).toContain('tnc_dur_seconds_sum 3.5');
      expect(lines).toContain('tnc_dur_seconds_count 2');
    });

    it('keeps a labelled histogram\u2019s labels alongside le', () => {
      const histogram = registry.histogram('tnc_dur_seconds', 'Durations.', [1]);
      histogram.observe(0.5, { share: 'programs' });

      const lines = linesOf(registry.render());
      expect(lines).toContain('tnc_dur_seconds_bucket{le="1",share="programs"} 1');
      expect(lines).toContain('tnc_dur_seconds_sum{share="programs"} 0.5');
    });

    it('ends with a newline', () => {
      registry.gauge('tnc_b', 'B.').set(1);
      // Without it a scraper treats the response as truncated and drops the last sample.
      expect(registry.render().endsWith('\n')).toBe(true);
    });

    it('renders nothing for an empty registry', () => {
      expect(registry.render()).toBe('');
    });

    it('escapes a label value that would otherwise break the line', () => {
      const gauge = registry.gauge('tnc_b', 'B.');
      gauge.set(1, { path: 'a"b' });
      expect(linesOf(registry.render())).toContain('tnc_b{path="a\\"b"} 1');
    });
  });

  it('lists its metric names', () => {
    registry.counter('tnc_b_total', 'B.');
    registry.counter('tnc_a_total', 'A.');
    expect(registry.names).toEqual(['tnc_a_total', 'tnc_b_total']);
  });

  it('resets every observation', () => {
    const counter = registry.counter('tnc_a_total', 'A.');
    counter.inc(5);
    registry.resetAll();
    expect(counter.get()).toBe(0);
  });
});

describe('createBridgeMetrics', () => {
  it('registers the metrics the monitoring spec names', () => {
    const metrics = createBridgeMetrics();
    const names = metrics.registry.names;

    for (const required of [
      'tnc_sync_files_total',
      'tnc_sync_duration_seconds',
      'tnc_lock_count',
      'tnc_error_total',
      'tnc_disk_usage_bytes',
      'tnc_network_throughput_bytes_per_second',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('uses base units, never megabytes or milliseconds', () => {
    const names = createBridgeMetrics().registry.names;
    // Grafana's unit formatting and every example dashboard assume base units; a metric
    // in megabytes silently graphs a thousand times off.
    expect(names.some((n) => /_(mb|ms|kb)(_|$)/.test(n))).toBe(false);
  });

  it('suffixes every counter with _total', () => {
    const metrics = createBridgeMetrics();
    for (const snapshot of metrics.registry.snapshot()) {
      if (snapshot.type === 'counter') {
        expect(snapshot.name.endsWith('_total')).toBe(true);
      }
    }
  });

  it('renders a valid exposition straight after construction', () => {
    const metrics = createBridgeMetrics();
    metrics.syncFiles.inc(3, { direction: 'pull' });
    metrics.locks.set(2);

    const lines = linesOf(metrics.registry.render());
    expect(lines).toContain('tnc_sync_files_total{direction="pull"} 3');
    expect(lines).toContain('tnc_lock_count 2');
  });
});
