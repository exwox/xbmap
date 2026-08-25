import { describe, expect, it } from 'vitest';

import { RingBuffer } from './ringBuffer';

describe('RingBuffer', () => {
  it('keeps values in chronological order and evicts the oldest', () => {
    const buffer = new RingBuffer<number>(3);

    expect(buffer.push(1)).toBeUndefined();
    buffer.pushMany([2, 3]);
    expect(buffer.toArray()).toEqual([1, 2, 3]);

    expect(buffer.push(4)).toBe(1);
    expect(buffer.toArray()).toEqual([2, 3, 4]);
    expect(buffer.first()).toBe(2);
    expect(buffer.last()).toBe(4);
  });

  it('supports positive and negative indexes', () => {
    const buffer = new RingBuffer<string>(2);
    buffer.pushMany(['old', 'new']);

    expect(buffer.at(0)).toBe('old');
    expect(buffer.at(-1)).toBe('new');
    expect(buffer.at(2)).toBeUndefined();
  });

  it('validates capacity and can be cleared', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);

    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    buffer.clear();

    expect(buffer.size).toBe(0);
    expect(buffer.isEmpty).toBe(true);
  });
});
