/**
 * An in-process metrics registry with a Prometheus text exposition (T41).
 *
 * Written rather than taken from `prom-client` for a reason that is specific to this
 * deployment: the bridge already ships a metrics *store* (`metrics_samples`, sampled on
 * an interval and queried by the dashboard), and a second library with its own registry,
 * its own default metrics and its own opinion about process collectors would mean two
 * unrelated sources of truth for "how many files synced". This registry is the one
 * source; {@link MetricsRegistry.snapshot} is what the sampler persists and what the
 * Prometheus endpoint renders, so the graph in the UI and the graph in Grafana cannot
 * disagree.
 *
 * ## What the exposition format actually requires
 *
 * The format is more particular than it looks, and getting it wrong produces a scrape
 * that fails silently or, worse, is parsed into the wrong series:
 *
 * - `# HELP` and `# TYPE` appear **once per family**, before its samples. Repeating them
 *   for every labelled child is a parse error in strict scrapers.
 * - A counter's name ends in `_total`, and the value is monotonic. Prometheus computes
 *   rates from the difference between scrapes, so a counter that resets or decreases
 *   yields a nonsense rate rather than an error.
 * - Histogram buckets are **cumulative** and must include `+Inf`, whose value equals
 *   `_count`. A non-cumulative histogram silently produces wrong quantiles.
 * - Label values escape backslash, double-quote and newline. Help text escapes backslash
 *   and newline but *not* quotes. These two rules genuinely differ, and applying the
 *   label rule to help text corrupts any help string containing a quote.
 */

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type Labels = Readonly<Record<string, string | number>>;

export type MetricType = 'counter' | 'gauge' | 'histogram';

/** Default bucket boundaries, in seconds, for sync durations. */
export const DEFAULT_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const;

export interface MetricSnapshot {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly labels: Labels;
  readonly value: number;
  /** Histograms only: cumulative bucket counts plus the observation sum. */
  readonly buckets?: readonly { readonly le: number; readonly count: number }[];
  readonly sum?: number;
  readonly count?: number;
}

/**
 * Escapes a label value: backslash, double-quote and newline.
 *
 * Order matters — backslash first, or the escapes introduced for quotes and newlines
 * would themselves be escaped a second time.
 */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Escapes help text: backslash and newline only. Quotes are legal in HELP. */
export function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Renders `{a="1",b="2"}`, or the empty string when there are no labels. */
export function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return '';
  }
  // Sorted so a series renders identically between scrapes; unstable ordering makes
  // diffing two scrapes by hand pointlessly hard.
  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapeLabelValue(String(value))}"`)
    .join(',');
  return `{${rendered}}`;
}

/**
 * Formats a number the way Prometheus expects.
 *
 * `Infinity` and `NaN` have specific spellings in the exposition format, and JavaScript's
 * default `String()` produces "Infinity"/"NaN" which a scraper rejects.
 */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === Number.POSITIVE_INFINITY) {
    return '+Inf';
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return '-Inf';
  }
  return String(value);
}

/** The key identifying one labelled child within a family. */
function childKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${String(v)}`).join(',');
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid metric name: ${JSON.stringify(name)}`);
  }
}

function assertLabels(labels: Labels): void {
  for (const key of Object.keys(labels)) {
    if (!LABEL_PATTERN.test(key)) {
      throw new Error(`Invalid label name: ${JSON.stringify(key)}`);
    }
  }
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
  ) {
    assertName(name);
  }

  abstract readonly type: MetricType;
  abstract snapshot(): MetricSnapshot[];
  abstract reset(): void;
}

/**
 * A monotonically increasing count.
 *
 * {@link Counter.inc} refuses a negative delta rather than accepting it. A counter that
 * can go down breaks every `rate()` built on it, and the failure shows up as a wrong
 * graph rather than an error — so it is rejected where the mistake is made.
 */
export class Counter extends Metric {
  readonly type = 'counter' as const;
  private readonly children = new Map<string, { labels: Labels; value: number }>();

  inc(delta = 1, labels: Labels = {}): void {
    if (delta < 0) {
      throw new Error(`A counter cannot decrease (got ${String(delta)})`);
    }
    assertLabels(labels);
    const key = childKey(labels);
    const existing = this.children.get(key);
    if (existing === undefined) {
      this.children.set(key, { labels, value: delta });
    } else {
      existing.value += delta;
    }
  }

  get(labels: Labels = {}): number {
    return this.children.get(childKey(labels))?.value ?? 0;
  }

  snapshot(): MetricSnapshot[] {
    if (this.children.size === 0) {
      // A counter with no observations still reports zero. Prometheus needs the series
      // to exist before an increment, or the first scrape after one looks like a reset.
      return [{ name: this.name, type: this.type, help: this.help, labels: {}, value: 0 }];
    }
    return [...this.children.values()].map((child) => ({
      name: this.name,
      type: this.type,
      help: this.help,
      labels: child.labels,
      value: child.value,
    }));
  }

  reset(): void {
    this.children.clear();
  }
}

/** A value that goes up and down: queue depth, active locks, disk bytes. */
export class Gauge extends Metric {
  readonly type = 'gauge' as const;
  private readonly children = new Map<string, { labels: Labels; value: number }>();

  set(value: number, labels: Labels = {}): void {
    assertLabels(labels);
    this.children.set(childKey(labels), { labels, value });
  }

  inc(delta = 1, labels: Labels = {}): void {
    this.set(this.get(labels) + delta, labels);
  }

  dec(delta = 1, labels: Labels = {}): void {
    this.set(this.get(labels) - delta, labels);
  }

  get(labels: Labels = {}): number {
    return this.children.get(childKey(labels))?.value ?? 0;
  }

  snapshot(): MetricSnapshot[] {
    if (this.children.size === 0) {
      return [{ name: this.name, type: this.type, help: this.help, labels: {}, value: 0 }];
    }
    return [...this.children.values()].map((child) => ({
      name: this.name,
      type: this.type,
      help: this.help,
      labels: child.labels,
      value: child.value,
    }));
  }

  reset(): void {
    this.children.clear();
  }
}

interface HistogramChild {
  labels: Labels;
  /** Per-boundary counts, *not* cumulative. Made cumulative at render time. */
  counts: number[];
  sum: number;
  count: number;
}

/**
 * Bucketed observations.
 *
 * Buckets are stored non-cumulatively and accumulated when rendered. Storing them
 * cumulatively would mean every observation updates every bucket at or above it — O(n)
 * per observation, on the sync hot path — where this way it is one increment and the
 * accumulation happens once per scrape.
 */
export class Histogram extends Metric {
  readonly type = 'histogram' as const;
  private readonly children = new Map<string, HistogramChild>();
  readonly boundaries: readonly number[];

  constructor(
    name: string,
    help: string,
    boundaries: readonly number[] = DEFAULT_DURATION_BUCKETS,
  ) {
    super(name, help);
    this.boundaries = [...boundaries].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    assertLabels(labels);
    const key = childKey(labels);
    let child = this.children.get(key);
    if (child === undefined) {
      child = {
        labels,
        counts: new Array<number>(this.boundaries.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.children.set(key, child);
    }
    child.sum += value;
    child.count += 1;

    // The first boundary at or above the value. Anything larger falls into +Inf only,
    // which is why +Inf is added at render time rather than stored.
    const index = this.boundaries.findIndex((boundary) => value <= boundary);
    if (index >= 0) {
      child.counts[index] = (child.counts[index] ?? 0) + 1;
    }
  }

  snapshot(): MetricSnapshot[] {
    return [...this.children.values()].map((child) => {
      const buckets: { le: number; count: number }[] = [];
      let cumulative = 0;
      for (let i = 0; i < this.boundaries.length; i += 1) {
        cumulative += child.counts[i] ?? 0;
        buckets.push({ le: this.boundaries[i]!, count: cumulative });
      }
      // +Inf always equals the total observation count.
      buckets.push({ le: Number.POSITIVE_INFINITY, count: child.count });

      return {
        name: this.name,
        type: this.type,
        help: this.help,
        labels: child.labels,
        value: child.count,
        buckets,
        sum: child.sum,
        count: child.count,
      };
    });
  }

  reset(): void {
    this.children.clear();
  }
}

/**
 * The registry: one place that owns every metric the process reports.
 *
 * Registration is idempotent by name so that a module re-imported under a test's module
 * registry does not throw; the second call returns the existing instrument rather than a
 * second one that would silently split the series in two.
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  counter(name: string, help: string): Counter {
    return this.getOrCreate(name, () => new Counter(name, help), Counter);
  }

  gauge(name: string, help: string): Gauge {
    return this.getOrCreate(name, () => new Gauge(name, help), Gauge);
  }

  histogram(name: string, help: string, boundaries?: readonly number[]): Histogram {
    return this.getOrCreate(
      name,
      () => new Histogram(name, help, boundaries ?? DEFAULT_DURATION_BUCKETS),
      Histogram,
    );
  }

  private getOrCreate<T extends Metric>(
    name: string,
    create: () => T,
    kind: abstract new (...args: never[]) => T,
  ): T {
    const existing = this.metrics.get(name);
    if (existing !== undefined) {
      if (!(existing instanceof kind)) {
        throw new Error(`Metric "${name}" is already registered with a different type`);
      }
      return existing;
    }
    const created = create();
    this.metrics.set(name, created);
    return created;
  }

  /** Every metric's current state, for the sampler and the exposition. */
  snapshot(): MetricSnapshot[] {
    const all: MetricSnapshot[] = [];
    for (const metric of this.metrics.values()) {
      all.push(...metric.snapshot());
    }
    return all;
  }

  /** Clears every observation. Used between tests, never in the running service. */
  resetAll(): void {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  get names(): string[] {
    return [...this.metrics.keys()].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Renders the Prometheus text exposition format.
   *
   * One `# HELP`/`# TYPE` pair per family, then that family's samples — the ordering the
   * format requires, and the reason this is a method on the registry rather than a
   * per-metric `toString()`.
   */
  render(): string {
    const lines: string[] = [];

    for (const metric of this.metrics.values()) {
      const samples = metric.snapshot();
      if (samples.length === 0) {
        continue;
      }

      lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      for (const sample of samples) {
        if (sample.type === 'histogram') {
          for (const bucket of sample.buckets ?? []) {
            const labels = formatLabels({ ...sample.labels, le: formatValue(bucket.le) });
            lines.push(`${metric.name}_bucket${labels} ${formatValue(bucket.count)}`);
          }
          lines.push(
            `${metric.name}_sum${formatLabels(sample.labels)} ${formatValue(sample.sum ?? 0)}`,
          );
          lines.push(
            `${metric.name}_count${formatLabels(sample.labels)} ${formatValue(sample.count ?? 0)}`,
          );
        } else {
          lines.push(`${metric.name}${formatLabels(sample.labels)} ${formatValue(sample.value)}`);
        }
      }
    }

    // The format requires a trailing newline; a scraper treats its absence as a truncated
    // response and discards the final sample.
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
  }
}

/**
 * The metrics this service reports, created once against a registry.
 *
 * Names follow the Prometheus conventions the spec asks for: a `tnc_` namespace, base
 * units (bytes and seconds, never megabytes or milliseconds), and `_total` on counters.
 * Base units matter more than they look — Grafana's unit formatting and every example
 * dashboard assume them, and a metric in megabytes silently graphs a thousand times off.
 */
export interface BridgeMetrics {
  readonly syncFiles: Counter;
  readonly syncBytes: Counter;
  readonly syncDuration: Histogram;
  readonly errors: Counter;
  readonly locks: Gauge;
  readonly queueDepth: Gauge;
  readonly diskUsage: Gauge;
  readonly diskFree: Gauge;
  readonly throughput: Gauge;
  readonly versionsStored: Gauge;
  readonly versionBytes: Gauge;
  readonly sharesOnline: Gauge;
  readonly uptime: Gauge;
  readonly registry: MetricsRegistry;
}

export function createBridgeMetrics(registry = new MetricsRegistry()): BridgeMetrics {
  return {
    registry,
    syncFiles: registry.counter(
      'tnc_sync_files_total',
      'Files synchronised, by share and direction.',
    ),
    syncBytes: registry.counter(
      'tnc_sync_bytes_total',
      'Bytes transferred, by share and direction.',
    ),
    syncDuration: registry.histogram(
      'tnc_sync_duration_seconds',
      'Time to synchronise one file, in seconds.',
    ),
    errors: registry.counter('tnc_error_total', 'Errors, by type.'),
    locks: registry.gauge('tnc_lock_count', 'Locks currently held, by origin.'),
    queueDepth: registry.gauge('tnc_queue_depth', 'Transfers waiting in the queue.'),
    diskUsage: registry.gauge('tnc_disk_usage_bytes', 'Bytes used on the cache filesystem.'),
    diskFree: registry.gauge('tnc_disk_free_bytes', 'Bytes free on the cache filesystem.'),
    throughput: registry.gauge(
      'tnc_network_throughput_bytes_per_second',
      'Current transfer throughput, by direction.',
    ),
    versionsStored: registry.gauge('tnc_versions_stored', 'Version rows currently retained.'),
    versionBytes: registry.gauge(
      'tnc_version_store_bytes',
      'Bytes held by the version blob store.',
    ),
    sharesOnline: registry.gauge('tnc_shares_online', 'Shares whose server link is reachable.'),
    uptime: registry.gauge('tnc_uptime_seconds', 'Seconds since the service started.'),
  };
}
