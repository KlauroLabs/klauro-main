export interface WeightedLruCacheOptions<V> {
  maxEntries: number;
  weightBudget: () => number;
  weightOf: (value: V) => number;
}

export class WeightedLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; weight: number }>();
  private totalWeight = 0;

  constructor(private readonly options: WeightedLruCacheOptions<V>) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): boolean {
    this.delete(key);
    const budget = Math.max(0, this.options.weightBudget());
    while (this.totalWeight > budget && this.entries.size > 0) this.evictOldest();
    const weight = Math.max(0, this.options.weightOf(value));
    if (weight > budget || this.options.maxEntries <= 0) return false;
    while (
      this.entries.size >= this.options.maxEntries ||
      this.totalWeight + weight > budget
    ) {
      if (this.entries.size === 0) break;
      this.evictOldest();
    }
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
    return true;
  }

  private delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalWeight -= entry.weight;
    this.entries.delete(key);
  }

  private evictOldest(): void {
    const key = this.entries.keys().next().value;
    if (key !== undefined) this.delete(key);
  }
}
