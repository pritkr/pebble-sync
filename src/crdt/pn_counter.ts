import { NodeId, PNCounterState } from '../types.js';

/**
 * Positive-Negative Counter CRDT (PN-Counter)
 * State-based CvRDT supporting concurrent increments and decrements across nodes.
 *
 * Guarantees:
 * - Commutative: merge(A, B) === merge(B, A)
 * - Associative: merge(merge(A, B), C) === merge(A, merge(B, C))
 * - Idempotent: merge(A, A) === A
 */
export class PNCounter {
  readonly nodeId: NodeId;
  private P: Record<NodeId, number>;
  private N: Record<NodeId, number>;

  constructor(nodeId: NodeId, initialState?: PNCounterState) {
    this.nodeId = nodeId;
    this.P = {};
    this.N = {};

    if (initialState) {
      for (const [k, v] of Object.entries(initialState.P || {})) {
        this.P[k] = Math.max(0, v);
      }
      for (const [k, v] of Object.entries(initialState.N || {})) {
        this.N[k] = Math.max(0, v);
      }
    }
  }

  /**
   * Current scalar integer value of the PN-Counter across all known nodes.
   */
  value(): number {
    let sumP = 0;
    let sumN = 0;
    for (const v of Object.values(this.P)) {
      sumP += v;
    }
    for (const v of Object.values(this.N)) {
      sumN += v;
    }
    return sumP - sumN;
  }

  /**
   * Increment by positive amount.
   * Returns a delta representing this mutation.
   */
  increment(amount = 1): PNCounterState {
    if (amount < 0) {
      return this.decrement(-amount);
    }
    if (amount === 0) {
      return { P: {}, N: {} };
    }
    const current = this.P[this.nodeId] ?? 0;
    const next = current + amount;
    this.P[this.nodeId] = next;

    return {
      P: { [this.nodeId]: next },
      N: {},
    };
  }

  /**
   * Decrement by positive amount.
   * Returns a delta representing this mutation.
   */
  decrement(amount = 1): PNCounterState {
    if (amount < 0) {
      return this.increment(-amount);
    }
    if (amount === 0) {
      return { P: {}, N: {} };
    }
    const current = this.N[this.nodeId] ?? 0;
    const next = current + amount;
    this.N[this.nodeId] = next;

    return {
      P: {},
      N: { [this.nodeId]: next },
    };
  }

  /**
   * Get immutable snapshot of current state.
   */
  state(): PNCounterState {
    return {
      P: { ...this.P },
      N: { ...this.N },
    };
  }

  /**
   * Merge external state or another PNCounter instance.
   * Takes pairwise maximum of P and N vectors.
   */
  merge(other: PNCounterState | PNCounter): void {
    const remote = other instanceof PNCounter ? other.state() : other;

    for (const [node, val] of Object.entries(remote.P || {})) {
      this.P[node] = Math.max(this.P[node] ?? 0, val);
    }
    for (const [node, val] of Object.entries(remote.N || {})) {
      this.N[node] = Math.max(this.N[node] ?? 0, val);
    }
  }

  /**
   * Pure merge of two PNCounter states.
   */
  static merge(a: PNCounterState, b: PNCounterState): PNCounterState {
    const P: Record<NodeId, number> = {};
    const N: Record<NodeId, number> = {};

    const allPKeys = new Set([...Object.keys(a.P || {}), ...Object.keys(b.P || {})]);
    for (const k of allPKeys) {
      P[k] = Math.max(a.P?.[k] ?? 0, b.P?.[k] ?? 0);
    }

    const allNKeys = new Set([...Object.keys(a.N || {}), ...Object.keys(b.N || {})]);
    for (const k of allNKeys) {
      N[k] = Math.max(a.N?.[k] ?? 0, b.N?.[k] ?? 0);
    }

    return { P, N };
  }

  /**
   * Clone this counter instance.
   */
  clone(nodeId: NodeId = this.nodeId): PNCounter {
    return new PNCounter(nodeId, this.state());
  }
}
