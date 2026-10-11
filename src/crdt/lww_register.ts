import { compareTimestamps, createTimestamp, LogicalTimestamp, LWWRegisterState, NodeId } from '../types.js';

/**
 * Last-Write-Wins Register CRDT (LWW-Register)
 * Resolves concurrent register updates using strict total ordering via
 * Hybrid Logical Timestamps (wallTime, logical counter, deterministic nodeId tiebreaker).
 */
export class LWWRegister<T = unknown> {
  readonly nodeId: NodeId;
  private val: T;
  private ts: LogicalTimestamp;
  private logicalCounter = 0;

  constructor(nodeId: NodeId, initialValue: T, initialTimestamp?: LogicalTimestamp) {
    this.nodeId = nodeId;
    this.val = initialValue;
    this.ts = initialTimestamp ?? createTimestamp(nodeId, Date.now(), 0);
    this.logicalCounter = this.ts.counter;
  }

  /**
   * Current value stored in register.
   */
  get(): T {
    return this.val;
  }

  /**
   * Current timestamp of the register.
   */
  get timestamp(): LogicalTimestamp {
    return { ...this.ts };
  }

  /**
   * Update value locally with an incremented logical timestamp.
   * Returns updated state.
   */
  set(value: T, customWallTime?: number): LWWRegisterState<T> {
    const now = customWallTime ?? Date.now();
    if (now > this.ts.wallTime) {
      this.logicalCounter = 0;
    } else {
      this.logicalCounter += 1;
    }

    this.val = value;
    this.ts = {
      wallTime: Math.max(now, this.ts.wallTime),
      counter: this.logicalCounter,
      nodeId: this.nodeId,
    };

    return this.state();
  }

  /**
   * Get immutable snapshot of current register state.
   */
  state(): LWWRegisterState<T> {
    return {
      value: this.val,
      timestamp: { ...this.ts },
    };
  }

  /**
   * Merge external register state.
   * If remote timestamp is strictly greater than local timestamp, remote wins.
   * Returns true if local value was updated.
   */
  merge(other: LWWRegisterState<T> | LWWRegister<T>): boolean {
    const remote = other instanceof LWWRegister ? other.state() : other;
    const cmp = compareTimestamps(remote.timestamp, this.ts);

    if (cmp > 0) {
      this.val = remote.value;
      this.ts = { ...remote.timestamp };
      if (remote.timestamp.nodeId === this.nodeId) {
        this.logicalCounter = Math.max(this.logicalCounter, remote.timestamp.counter);
      }
      return true;
    }

    return false;
  }

  /**
   * Pure merge of two LWW-Register states.
   */
  static merge<V>(a: LWWRegisterState<V>, b: LWWRegisterState<V>): LWWRegisterState<V> {
    const cmp = compareTimestamps(a.timestamp, b.timestamp);
    if (cmp >= 0) {
      return { value: a.value, timestamp: { ...a.timestamp } };
    }
    return { value: b.value, timestamp: { ...b.timestamp } };
  }

  /**
   * Clone this register.
   */
  clone(nodeId: NodeId = this.nodeId): LWWRegister<T> {
    return new LWWRegister<T>(nodeId, this.val, this.state().timestamp);
  }
}
