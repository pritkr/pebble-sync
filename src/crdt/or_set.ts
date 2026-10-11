import { NodeId, ORSetState } from '../types.js';

/**
 * Observed-Remove Set (OR-Set / Add-Wins Set CRDT)
 * Supports concurrent additions and removals.
 * An element is present if the set of addition tags minus the set of tombstone tags is non-empty.
 * Additions concurrently occurring alongside deletions always win (Add-Wins).
 */
export class ORSet<T = unknown> {
  readonly nodeId: NodeId;
  private adds: Map<string, { value: T; tags: Set<string> }>;
  private tombstones: Set<string>;
  private tagCounter = 0;

  constructor(nodeId: NodeId, initialState?: ORSetState<T>) {
    this.nodeId = nodeId;
    this.adds = new Map();
    this.tombstones = new Set();

    if (initialState) {
      if (initialState.tombstones) {
        for (const t of initialState.tombstones) {
          this.tombstones.add(t);
        }
      }
      if (initialState.adds) {
        for (const [key, item] of Object.entries(initialState.adds)) {
          this.adds.set(key, {
            value: item.value,
            tags: new Set(item.tags),
          });
        }
      }
    }
  }

  private elementKey(element: T): string {
    if (typeof element === 'string' || typeof element === 'number' || typeof element === 'boolean') {
      return `${typeof element}:${String(element)}`;
    }
    return `json:${JSON.stringify(element, Object.keys(element as object).sort())}`;
  }

  private generateTag(): string {
    this.tagCounter += 1;
    const randomHex = Math.random().toString(36).slice(2, 9);
    return `${this.nodeId}:${Date.now()}:${this.tagCounter}:${randomHex}`;
  }

  /**
   * Add element to set with a unique tag.
   * Returns generated tag.
   */
  add(element: T, explicitTag?: string): string {
    const key = this.elementKey(element);
    const tag = explicitTag ?? this.generateTag();

    const existing = this.adds.get(key);
    if (existing) {
      existing.tags.add(tag);
      existing.value = element;
    } else {
      this.adds.set(key, {
        value: element,
        tags: new Set([tag]),
      });
    }

    return tag;
  }

  /**
   * Remove element from set by tombstoning all currently observed tags for it.
   * Returns the list of tombstoned tags.
   */
  remove(element: T): string[] {
    const key = this.elementKey(element);
    const existing = this.adds.get(key);
    if (!existing) {
      return [];
    }

    const removedTags: string[] = [];
    for (const tag of existing.tags) {
      if (!this.tombstones.has(tag)) {
        this.tombstones.add(tag);
        removedTags.push(tag);
      }
    }

    return removedTags;
  }

  /**
   * Check if element is currently present.
   */
  has(element: T): boolean {
    const key = this.elementKey(element);
    const existing = this.adds.get(key);
    if (!existing) return false;

    for (const tag of existing.tags) {
      if (!this.tombstones.has(tag)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all currently present active elements.
   */
  read(): T[] {
    const result: T[] = [];
    for (const [, item] of this.adds) {
      let active = false;
      for (const tag of item.tags) {
        if (!this.tombstones.has(tag)) {
          active = true;
          break;
        }
      }
      if (active) {
        result.push(item.value);
      }
    }
    return result.sort((a, b) => {
      const strA = typeof a === 'string' ? a : JSON.stringify(a);
      const strB = typeof b === 'string' ? b : JSON.stringify(b);
      return strA.localeCompare(strB);
    });
  }

  /**
   * Number of active items in the set.
   */
  size(): number {
    return this.read().length;
  }

  /**
   * Return copy of current tombstone tags.
   */
  getTombstones(): string[] {
    return Array.from(this.tombstones);
  }

  /**
   * Permanently garbage-collect stable tombstones past the causal horizon.
   * Removes tags from tombstones and purges dead elements from adds map.
   */
  pruneTombstones(tagsToPrune: Iterable<string>): number {
    const targetSet = new Set(tagsToPrune);
    let count = 0;

    for (const tag of targetSet) {
      if (this.tombstones.delete(tag)) {
        count++;
      }
    }

    // Also purge pruned tags from adds, and delete empty add entries to reclaim memory
    for (const [key, item] of this.adds.entries()) {
      for (const tag of targetSet) {
        item.tags.delete(tag);
      }
      if (item.tags.size === 0) {
        this.adds.delete(key);
      }
    }

    return count;
  }

  /**
   * Snapshot serializable representation of this ORSet.
   */
  state(): ORSetState<T> {
    const addsRecord: Record<string, { value: T; tags: string[] }> = {};
    for (const [key, item] of this.adds.entries()) {
      addsRecord[key] = {
        value: item.value,
        tags: Array.from(item.tags),
      };
    }

    return {
      adds: addsRecord,
      tombstones: Array.from(this.tombstones),
    };
  }

  /**
   * Merge another ORSet or state.
   */
  merge(other: ORSetState<T> | ORSet<T>): void {
    const remote = other instanceof ORSet ? other.state() : other;

    // Union tombstones
    for (const t of remote.tombstones || []) {
      this.tombstones.add(t);
    }

    // Union adds
    for (const [key, item] of Object.entries(remote.adds || {})) {
      const existing = this.adds.get(key);
      if (existing) {
        for (const tag of item.tags) {
          existing.tags.add(tag);
        }
      } else {
        this.adds.set(key, {
          value: item.value,
          tags: new Set(item.tags),
        });
      }
    }
  }

  /**
   * Pure merge of two ORSet states.
   */
  static merge<V>(a: ORSetState<V>, b: ORSetState<V>): ORSetState<V> {
    const tombstones = new Set<string>([...(a.tombstones || []), ...(b.tombstones || [])]);
    const addsRecord: Record<string, { value: V; tags: string[] }> = {};

    const allKeys = new Set([...Object.keys(a.adds || {}), ...Object.keys(b.adds || {})]);
    for (const k of allKeys) {
      const itemA = a.adds?.[k];
      const itemB = b.adds?.[k];
      const val = itemA ? itemA.value : itemB!.value;
      const combinedTags = new Set<string>([
        ...(itemA ? itemA.tags : []),
        ...(itemB ? itemB.tags : []),
      ]);
      addsRecord[k] = {
        value: val,
        tags: Array.from(combinedTags),
      };
    }

    return {
      adds: addsRecord,
      tombstones: Array.from(tombstones),
    };
  }

  /**
   * Clone this ORSet instance.
   */
  clone(nodeId: NodeId = this.nodeId): ORSet<T> {
    return new ORSet<T>(nodeId, this.state());
  }
}
