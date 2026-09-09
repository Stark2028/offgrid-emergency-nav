/**
 * Binary min-heap over (nodeId, priority) pairs, backed by typed arrays.
 *
 * Object-based priority queues allocate on every push and put the GC squarely
 * in the routing hot loop. Two parallel typed arrays plus an index map keep the
 * whole thing allocation-free after construction.
 *
 * Supports decrease-key, which A* needs when it finds a cheaper path to a node
 * already queued. The alternative — pushing duplicates and skipping stale pops —
 * is simpler but lets the heap grow to O(E), which on a 209k-edge graph is a
 * lot of avoidable memory traffic.
 */
export class MinHeap {
  private readonly nodes: Uint32Array;
  private readonly priorities: Uint32Array;
  /** nodeId -> heap slot, or ABSENT. Doubles as the "is queued" test. */
  private readonly positions: Int32Array;
  private length = 0;

  private static readonly ABSENT = -1;

  /**
   * @param capacity Max simultaneously-queued nodes. Callers size this to the
   *   node count of the loaded graph, so pushes can never overflow.
   */
  constructor(capacity: number) {
    this.nodes = new Uint32Array(capacity);
    this.priorities = new Uint32Array(capacity);
    this.positions = new Int32Array(capacity).fill(MinHeap.ABSENT);
  }

  get size(): number {
    return this.length;
  }

  isEmpty(): boolean {
    return this.length === 0;
  }

  has(nodeId: number): boolean {
    return this.positions[nodeId] !== MinHeap.ABSENT;
  }

  /** Priority of a queued node, or undefined if not queued. */
  priorityOf(nodeId: number): number | undefined {
    const slot = this.positions[nodeId]!;
    return slot === MinHeap.ABSENT ? undefined : this.priorities[slot]!;
  }

  /**
   * Lowest priority in the heap without removing it.
   *
   * This is `topF`/`topB` in the bidirectional termination check, so it is read
   * once per iteration and must stay O(1).
   */
  peekPriority(): number | undefined {
    return this.length === 0 ? undefined : this.priorities[0]!;
  }

  /** Insert, or lower the priority of an already-queued node. */
  push(nodeId: number, priority: number): void {
    const existing = this.positions[nodeId]!;
    if (existing !== MinHeap.ABSENT) {
      if (priority < this.priorities[existing]!) {
        this.priorities[existing] = priority;
        this.siftUp(existing);
      }
      return;
    }
    const slot = this.length++;
    this.nodes[slot] = nodeId;
    this.priorities[slot] = priority;
    this.positions[nodeId] = slot;
    this.siftUp(slot);
  }

  /** Remove and return the minimum-priority node, or -1 when empty. */
  pop(): number {
    if (this.length === 0) return -1;

    const top = this.nodes[0]!;
    this.positions[top] = MinHeap.ABSENT;
    this.length--;

    if (this.length > 0) {
      const lastNode = this.nodes[this.length]!;
      this.nodes[0] = lastNode;
      this.priorities[0] = this.priorities[this.length]!;
      this.positions[lastNode] = 0;
      this.siftDown(0);
    }
    return top;
  }

  clear(): void {
    for (let i = 0; i < this.length; i++) this.positions[this.nodes[i]!] = MinHeap.ABSENT;
    this.length = 0;
  }

  private siftUp(start: number): void {
    const { nodes, priorities, positions } = this;
    const node = nodes[start]!;
    const priority = priorities[start]!;
    let slot = start;

    while (slot > 0) {
      const parent = (slot - 1) >>> 1;
      if (priorities[parent]! <= priority) break;
      nodes[slot] = nodes[parent]!;
      priorities[slot] = priorities[parent]!;
      positions[nodes[slot]!] = slot;
      slot = parent;
    }
    nodes[slot] = node;
    priorities[slot] = priority;
    positions[node] = slot;
  }

  private siftDown(start: number): void {
    const { nodes, priorities, positions, length } = this;
    const node = nodes[start]!;
    const priority = priorities[start]!;
    let slot = start;

    for (;;) {
      const left = 2 * slot + 1;
      if (left >= length) break;
      const right = left + 1;
      const child = right < length && priorities[right]! < priorities[left]! ? right : left;
      if (priorities[child]! >= priority) break;
      nodes[slot] = nodes[child]!;
      priorities[slot] = priorities[child]!;
      positions[nodes[slot]!] = slot;
      slot = child;
    }
    nodes[slot] = node;
    priorities[slot] = priority;
    positions[node] = slot;
  }
}
