import { describe, expect, it } from "vitest";
import { MinHeap } from "../src/routing/heap.js";

/** Deterministic PRNG (mulberry32) so a failing fuzz case is reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("MinHeap", () => {
  it("pops in ascending priority order", () => {
    const heap = new MinHeap(8);
    heap.push(3, 30);
    heap.push(1, 10);
    heap.push(2, 20);

    expect(heap.pop()).toBe(1);
    expect(heap.pop()).toBe(2);
    expect(heap.pop()).toBe(3);
    expect(heap.isEmpty()).toBe(true);
  });

  it("returns -1 when popping an empty heap", () => {
    expect(new MinHeap(4).pop()).toBe(-1);
  });

  it("tracks membership and size", () => {
    const heap = new MinHeap(4);
    expect(heap.has(2)).toBe(false);

    heap.push(2, 50);
    expect(heap.has(2)).toBe(true);
    expect(heap.size).toBe(1);
    expect(heap.priorityOf(2)).toBe(50);

    heap.pop();
    expect(heap.has(2)).toBe(false);
    expect(heap.priorityOf(2)).toBeUndefined();
  });

  it("decreases the key of a queued node", () => {
    const heap = new MinHeap(4);
    heap.push(0, 100);
    heap.push(1, 50);

    heap.push(0, 10); // 0 should now outrank 1
    expect(heap.size).toBe(2); // decrease-key, not a duplicate insert
    expect(heap.priorityOf(0)).toBe(10);
    expect(heap.pop()).toBe(0);
    expect(heap.pop()).toBe(1);
  });

  it("ignores a push that would raise an existing priority", () => {
    const heap = new MinHeap(4);
    heap.push(0, 10);
    heap.push(0, 99);

    expect(heap.priorityOf(0)).toBe(10);
    expect(heap.size).toBe(1);
  });

  it("peekPriority reports the minimum without removing it", () => {
    const heap = new MinHeap(4);
    expect(heap.peekPriority()).toBeUndefined();

    heap.push(0, 70);
    heap.push(1, 20);
    expect(heap.peekPriority()).toBe(20);
    expect(heap.size).toBe(2);
  });

  it("clear empties the heap and resets membership", () => {
    const heap = new MinHeap(4);
    heap.push(0, 10);
    heap.push(1, 20);
    heap.clear();

    expect(heap.isEmpty()).toBe(true);
    expect(heap.has(0)).toBe(false);
    // Reusable afterwards — the router clears between searches.
    heap.push(2, 5);
    expect(heap.pop()).toBe(2);
  });

  it("handles equal priorities without losing nodes", () => {
    const heap = new MinHeap(16);
    for (let i = 0; i < 10; i++) heap.push(i, 42);

    const popped = new Set<number>();
    while (!heap.isEmpty()) popped.add(heap.pop());
    expect(popped.size).toBe(10);
  });

  // The real test: random push/decrease-key/pop against a sorted-array oracle.
  // Heap bugs hide behind small hand-written cases and surface only under churn.
  it("matches a reference implementation under random operations", () => {
    const rng = makeRng(0x0ff6_71d);
    const capacity = 200;

    for (let trial = 0; trial < 200; trial++) {
      const heap = new MinHeap(capacity);
      const reference = new Map<number, number>();

      for (let op = 0; op < 400; op++) {
        if (rng() < 0.6) {
          const node = Math.floor(rng() * capacity);
          const priority = Math.floor(rng() * 10_000);
          heap.push(node, priority);

          // Mirror decrease-key semantics: keep the lower priority.
          const prior = reference.get(node);
          if (prior === undefined || priority < prior) reference.set(node, priority);
        } else {
          const expectedMin =
            reference.size === 0 ? undefined : Math.min(...reference.values());
          expect(heap.peekPriority()).toBe(expectedMin);

          const got = heap.pop();
          if (expectedMin === undefined) {
            expect(got).toBe(-1);
          } else {
            // Ties make the winner ambiguous; assert the priority, not the node.
            expect(reference.get(got)).toBe(expectedMin);
            reference.delete(got);
          }
        }
        expect(heap.size).toBe(reference.size);
      }
    }
  });
});
