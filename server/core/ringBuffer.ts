/** Fixed-capacity FIFO with O(1) append and bounded memory. */
export class RingBuffer<T> {
  private values: Array<T | undefined>;
  private start = 0;
  private lengthValue = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("RingBuffer capacity must be a positive integer");
    }
    this.values = new Array<T | undefined>(capacity);
  }

  get length(): number {
    return this.lengthValue;
  }

  push(value: T): void {
    const end = (this.start + this.lengthValue) % this.capacity;
    this.values[end] = value;
    if (this.lengthValue < this.capacity) {
      this.lengthValue += 1;
      return;
    }
    this.start = (this.start + 1) % this.capacity;
  }

  clear(): void {
    this.values = new Array<T | undefined>(this.capacity);
    this.start = 0;
    this.lengthValue = 0;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let index = 0; index < this.lengthValue; index += 1) {
      const value = this.values[(this.start + index) % this.capacity];
      if (value !== undefined) result.push(value);
    }
    return result;
  }

  latest(): T | undefined {
    if (this.lengthValue === 0) return undefined;
    return this.values[(this.start + this.lengthValue - 1) % this.capacity];
  }
}
