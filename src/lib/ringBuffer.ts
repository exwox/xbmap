/**
 * Fixed-capacity FIFO buffer. Values are always exposed from oldest to newest.
 * It avoids the unbounded arrays that are especially costly on a live feed.
 */
export class RingBuffer<T> implements Iterable<T> {
  readonly capacity: number;

  private values: Array<T | undefined>;
  private start = 0;
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('RingBuffer capacity must be a positive integer');
    }

    this.capacity = capacity;
    this.values = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /** Adds a value and returns the evicted value, when one exists. */
  push(value: T): T | undefined {
    if (this.count < this.capacity) {
      const index = (this.start + this.count) % this.capacity;
      this.values[index] = value;
      this.count += 1;
      return undefined;
    }

    const evicted = this.values[this.start];
    this.values[this.start] = value;
    this.start = (this.start + 1) % this.capacity;
    return evicted;
  }

  pushMany(values: Iterable<T>): void {
    for (const value of values) {
      this.push(value);
    }
  }

  /** Indexes from the oldest value; negative indexes count back from newest. */
  at(index: number): T | undefined {
    const normalized = index < 0 ? this.count + index : index;
    if (!Number.isInteger(normalized) || normalized < 0 || normalized >= this.count) {
      return undefined;
    }

    return this.values[(this.start + normalized) % this.capacity];
  }

  first(): T | undefined {
    return this.at(0);
  }

  last(): T | undefined {
    return this.at(-1);
  }

  clear(): void {
    this.values = new Array<T | undefined>(this.capacity);
    this.start = 0;
    this.count = 0;
  }

  toArray(): T[] {
    return Array.from(this);
  }

  *[Symbol.iterator](): Iterator<T> {
    for (let index = 0; index < this.count; index += 1) {
      const value = this.values[(this.start + index) % this.capacity];
      // Slots inside count are initialized, including when T itself permits undefined.
      yield value as T;
    }
  }
}
