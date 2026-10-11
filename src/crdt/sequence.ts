import {
  LogicalTimestamp,
  NodeId,
  VectorClock,
  createTimestamp,
  vectorClockIncrement,
  vectorClockMerge,
} from '../types.js';

/**
 * Fractional logical positional identifier segment.
 * Models Fugue-lite hierarchical origin references and dense run offsets:
 * [originId, offset] parameterized by nodeId and counter for strict total ordering.
 */
export interface PositionSegment {
  originId: string; // Base origin / anchor identifier
  offset: number;   // Linear offset for consecutive typing runs
  nodeId: NodeId;   // Deterministic tie-breaker
  counter: number;  // Logical tick for strict ordering
}

export type PositionKey = PositionSegment[];

/**
 * Item in the collaborative sequence CRDT.
 */
export interface SequenceItem<T = unknown> {
  id: string; // Unique identifier: `${nodeId}:${counter}`
  position: PositionKey;
  value: T;
  deleted: boolean;
  timestamp: LogicalTimestamp;
  nodeId: NodeId;
  counter: number;
}

export interface SequenceState<T = unknown> {
  items: SequenceItem<T>[];
  clock: VectorClock;
}

export type SequenceOperation<T = unknown> =
  | { op: 'insert'; item: SequenceItem<T> }
  | { op: 'delete'; id: string; timestamp: LogicalTimestamp };

/**
 * Compare two position segments deterministically.
 */
export function compareSegments(a: PositionSegment, b: PositionSegment): number {
  if (a.originId !== b.originId) {
    return a.originId.localeCompare(b.originId);
  }
  if (a.nodeId !== b.nodeId) {
    return a.nodeId.localeCompare(b.nodeId);
  }
  if (a.offset !== b.offset) {
    return a.offset - b.offset;
  }
  if (a.counter !== b.counter) {
    return a.counter - b.counter;
  }
  return 0;
}

/**
 * Compare two fractional logical position keys lexicographically.
 * Guarantees a deterministic strict total order.
 */
export function comparePositionKeys(a: PositionKey, b: PositionKey): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    const diff = compareSegments(a[i], b[i]);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/**
 * Compare two sequence items by their position key, breaking ties by timestamp and ID.
 */
export function compareSequenceItems<T>(a: SequenceItem<T>, b: SequenceItem<T>): number {
  const posDiff = comparePositionKeys(a.position, b.position);
  if (posDiff !== 0) return posDiff;

  if (a.timestamp.wallTime !== b.timestamp.wallTime) {
    return a.timestamp.wallTime - b.timestamp.wallTime;
  }
  if (a.counter !== b.counter) {
    return a.counter - b.counter;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Allocate a new fractional logical position strictly between left and right keys.
 * Implements Fugue-lite run-length compaction to prevent depth explosion during
 * consecutive typing while guaranteeing non-interleaving under concurrent edits.
 */
export function allocatePosition(
  left: PositionKey | null,
  right: PositionKey | null,
  nodeId: NodeId,
  counter: number
): PositionKey {
  // Case 1: Empty sequence (first item)
  if (!left && !right) {
    return [{ originId: 'root', offset: 0, nodeId, counter }];
  }

  // Case 2: Append at end of sequence
  if (left && !right) {
    const lastSeg = left[left.length - 1];
    // If consecutive typing by same node at same depth, increment offset
    if (lastSeg.nodeId === nodeId) {
      return [
        ...left.slice(0, -1),
        { originId: lastSeg.originId, offset: lastSeg.offset + 1, nodeId, counter },
      ];
    }
    // Otherwise attach child run
    return [
      ...left,
      { originId: `${nodeId}:${counter}`, offset: 0, nodeId, counter },
    ];
  }

  // Case 3: Prepend at beginning of sequence
  if (!left && right) {
    const firstSeg = right[0];
    if (firstSeg.nodeId === nodeId) {
      return [
        { originId: firstSeg.originId, offset: firstSeg.offset - 1, nodeId, counter },
      ];
    }
    return [
      { originId: `!_${firstSeg.originId}`, offset: 0, nodeId, counter },
    ];
  }

  // Case 4: Insert between left and right (left < right)
  const l = left!;
  const r = right!;

  // Try extending left's last segment if authored by same node
  const lastSeg = l[l.length - 1];
  if (lastSeg.nodeId === nodeId) {
    const candidate: PositionKey = [
      ...l.slice(0, -1),
      { originId: lastSeg.originId, offset: lastSeg.offset + 1, nodeId, counter },
    ];
    if (comparePositionKeys(candidate, r) < 0) {
      return candidate;
    }
  }

  // Find first divergence point between l and r
  let diffIndex = 0;
  while (diffIndex < l.length && diffIndex < r.length) {
    if (compareSegments(l[diffIndex], r[diffIndex]) !== 0) {
      break;
    }
    diffIndex++;
  }

  // If there is room between offsets at divergence level
  if (diffIndex < l.length && diffIndex < r.length) {
    const segL = l[diffIndex];
    const segR = r[diffIndex];
    if (segL.originId === segR.originId && segL.nodeId === segR.nodeId && segR.offset - segL.offset > 1) {
      const midOffset = Math.floor((segL.offset + segR.offset) / 2);
      return [
        ...l.slice(0, diffIndex),
        { originId: segL.originId, offset: midOffset, nodeId, counter },
      ];
    }
  }

  // Default descent: append a new child segment under left
  const childOrigin = `${nodeId}:${counter}`;
  const candidate: PositionKey = [
    ...l,
    { originId: childOrigin, offset: 0, nodeId, counter },
  ];

  if (comparePositionKeys(candidate, r) < 0) {
    return candidate;
  }

  // If candidate exceeds r, prepend origin prefix relative to r
  const targetOrigin = r.length > l.length ? r[l.length].originId : childOrigin;
  return [
    ...l,
    { originId: `!_${targetOrigin}`, offset: 0, nodeId, counter },
  ];
}

/**
 * Collaborative Sequence CRDT (Fugue-lite)
 * Supports rich-text, strings, and clinical records editing.
 * Guarantees convergence, deterministic tie-breaking, and non-interleaving
 * of concurrent typing runs across offline network partitions.
 */
export class SequenceCRDT<T = unknown> {
  readonly nodeId: NodeId;
  private items: SequenceItem<T>[] = [];
  private itemIndex = new Map<string, SequenceItem<T>>();
  private logicalCounter = 0;
  private clock: VectorClock = {};

  constructor(nodeId: NodeId, initialState?: SequenceState<T>) {
    this.nodeId = nodeId;
    if (initialState) {
      this.clock = { ...initialState.clock };
      for (const item of initialState.items) {
        const cloned: SequenceItem<T> = {
          ...item,
          position: item.position.map((s) => ({ ...s })),
          timestamp: { ...item.timestamp },
        };
        this.items.push(cloned);
        this.itemIndex.set(cloned.id, cloned);
        if (cloned.counter > this.logicalCounter) {
          this.logicalCounter = cloned.counter;
        }
      }
      this.items.sort(compareSequenceItems);
    }
  }

  private nextCounter(): number {
    this.logicalCounter += 1;
    this.clock = vectorClockIncrement(this.clock, this.nodeId);
    return this.logicalCounter;
  }

  private nextTimestamp(counter: number): LogicalTimestamp {
    return createTimestamp(this.nodeId, Date.now(), counter);
  }

  /**
   * Find internal array index corresponding to the k-th active (non-deleted) item.
   * If k === activeCount, returns items.length.
   */
  private findActivePosition(k: number): number {
    if (k < 0) return 0;
    let activeSeen = 0;
    for (let i = 0; i < this.items.length; i++) {
      if (!this.items[i].deleted) {
        if (activeSeen === k) {
          return i;
        }
        activeSeen++;
      }
    }
    return this.items.length;
  }

  /**
   * Number of visible, active (non-deleted) items in the sequence.
   */
  get length(): number {
    let count = 0;
    for (let i = 0; i < this.items.length; i++) {
      if (!this.items[i].deleted) count++;
    }
    return count;
  }

  /**
   * Size alias for length.
   */
  size(): number {
    return this.length;
  }

  /**
   * Insert a single value at the given visible index (0-based).
   * Returns created SequenceItem.
   */
  insert(index: number, value: T): SequenceItem<T> {
    const clampedIndex = Math.max(0, Math.min(index, this.length));
    const targetIdx = this.findActivePosition(clampedIndex);

    // Left neighbor is previous item in items array (including tombstones for stability)
    const leftItem = targetIdx > 0 ? this.items[targetIdx - 1] : null;
    const rightItem = targetIdx < this.items.length ? this.items[targetIdx] : null;

    const counter = this.nextCounter();
    const position = allocatePosition(
      leftItem ? leftItem.position : null,
      rightItem ? rightItem.position : null,
      this.nodeId,
      counter
    );

    const item: SequenceItem<T> = {
      id: `${this.nodeId}:${counter}`,
      position,
      value,
      deleted: false,
      timestamp: this.nextTimestamp(counter),
      nodeId: this.nodeId,
      counter,
    };

    this.insertItemInternal(item);
    return item;
  }

  /**
   * Insert an array of values at the given visible index.
   */
  insertRange(index: number, values: T[]): SequenceItem<T>[] {
    const created: SequenceItem<T>[] = [];
    let curr = index;
    for (const val of values) {
      created.push(this.insert(curr, val));
      curr++;
    }
    return created;
  }

  /**
   * Insert text as characters (convenience for string sequences / clinical notes).
   */
  insertText(index: number, text: string): SequenceItem<T>[] {
    const chars = Array.from(text) as unknown as T[];
    return this.insertRange(index, chars);
  }

  /**
   * Delete item at visible index (0-based).
   * Marks item as tombstoned.
   */
  delete(index: number): SequenceItem<T> | undefined {
    if (index < 0 || index >= this.length) {
      return undefined;
    }
    const targetIdx = this.findActivePosition(index);
    if (targetIdx < this.items.length) {
      const item = this.items[targetIdx];
      item.deleted = true;
      item.timestamp = this.nextTimestamp(this.nextCounter());
      return item;
    }
    return undefined;
  }

  /**
   * Delete a range of visible items.
   */
  deleteRange(index: number, count: number): SequenceItem<T>[] {
    const deleted: SequenceItem<T>[] = [];
    for (let i = 0; i < count; i++) {
      const item = this.delete(index);
      if (item) {
        deleted.push(item);
      } else {
        break;
      }
    }
    return deleted;
  }

  /**
   * Get visible value at visible index.
   */
  get(index: number): T | undefined {
    if (index < 0 || index >= this.length) return undefined;
    const targetIdx = this.findActivePosition(index);
    return targetIdx < this.items.length ? this.items[targetIdx].value : undefined;
  }

  /**
   * Retrieve all visible values in sequential order.
   */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.items.length; i++) {
      if (!this.items[i].deleted) {
        result.push(this.items[i].value);
      }
    }
    return result;
  }

  /**
   * Render active items as string (for text CRDTs).
   */
  toString(): string {
    return this.toArray().join('');
  }

  /**
   * Get all underlying items (including tombstones).
   */
  getItems(): SequenceItem<T>[] {
    return this.items.slice();
  }

  /**
   * Internal binary insertion maintaining sorted order.
   */
  private insertItemInternal(item: SequenceItem<T>): boolean {
    if (this.itemIndex.has(item.id)) {
      return false;
    }

    // Binary search for insertion point
    let low = 0;
    let high = this.items.length;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (compareSequenceItems(this.items[mid], item) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    this.items.splice(low, 0, item);
    this.itemIndex.set(item.id, item);
    return true;
  }

  /**
   * Apply an incoming operation.
   */
  applyOperation(op: SequenceOperation<T>): void {
    if (op.op === 'insert') {
      const added = this.insertItemInternal(op.item);
      if (added) {
        this.clock = vectorClockMerge(this.clock, { [op.item.nodeId]: op.item.counter });
      }
    } else if (op.op === 'delete') {
      const item = this.itemIndex.get(op.id);
      if (item) {
        item.deleted = true;
      }
    }
  }

  /**
   * Snapshot serializable representation of this SequenceCRDT.
   */
  state(): SequenceState<T> {
    return {
      items: this.items.map((it) => ({
        ...it,
        position: it.position.map((s) => ({ ...s })),
        timestamp: { ...it.timestamp },
      })),
      clock: { ...this.clock },
    };
  }

  /**
   * Merge external SequenceCRDT or state into this instance.
   */
  merge(other: SequenceCRDT<T> | SequenceState<T>): void {
    const remote = other instanceof SequenceCRDT ? other.state() : other;
    this.clock = vectorClockMerge(this.clock, remote.clock);

    for (const remoteItem of remote.items) {
      const existing = this.itemIndex.get(remoteItem.id);
      if (existing) {
        // Tombstone wins
        if (remoteItem.deleted) {
          existing.deleted = true;
        }
      } else {
        const cloned: SequenceItem<T> = {
          ...remoteItem,
          position: remoteItem.position.map((s) => ({ ...s })),
          timestamp: { ...remoteItem.timestamp },
        };
        this.insertItemInternal(cloned);
      }
    }
  }

  /**
   * Pure merge of two SequenceState instances.
   */
  static merge<V>(a: SequenceState<V>, b: SequenceState<V>): SequenceState<V> {
    const mergedClock = vectorClockMerge(a.clock, b.clock);
    const itemMap = new Map<string, SequenceItem<V>>();

    for (const it of a.items) {
      itemMap.set(it.id, {
        ...it,
        position: it.position.map((s) => ({ ...s })),
        timestamp: { ...it.timestamp },
      });
    }

    for (const it of b.items) {
      const existing = itemMap.get(it.id);
      if (existing) {
        if (it.deleted) {
          existing.deleted = true;
        }
      } else {
        itemMap.set(it.id, {
          ...it,
          position: it.position.map((s) => ({ ...s })),
          timestamp: { ...it.timestamp },
        });
      }
    }

    const mergedItems = Array.from(itemMap.values()).sort(compareSequenceItems);
    return {
      items: mergedItems,
      clock: mergedClock,
    };
  }

  /**
   * Clone this SequenceCRDT replica.
   */
  clone(nodeId: NodeId = this.nodeId): SequenceCRDT<T> {
    return new SequenceCRDT<T>(nodeId, this.state());
  }

  toJSON(): unknown {
    return this.toArray();
  }
}
