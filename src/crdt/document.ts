import {
  DocumentFieldValue,
  DocumentPatch,
  DocumentState,
  LogicalTimestamp,
  NodeId,
  createTimestamp,
  compareTimestamps,
} from '../types.js';
import { PNCounter } from './pn_counter.js';
import { LWWRegister } from './lww_register.js';
import { ORSet } from './or_set.js';

export function normalizePath(path: string | string[]): string[] {
  if (Array.isArray(path)) {
    return path.filter((p) => p.length > 0);
  }
  return path.split('.').filter((p) => p.length > 0);
}

/**
 * Collaborative Document CRDT
 * Supports nested documents, LWW registers, PN counters, and OR sets.
 * Guarantees conflict-free convergence under concurrent peer edits.
 */
export class DocumentCRDT {
  readonly nodeId: NodeId;
  private fields: Map<string, DocumentFieldValue>;
  private logicalCounter = 0;

  constructor(nodeId: NodeId, initialState?: DocumentState) {
    this.nodeId = nodeId;
    this.fields = new Map();

    if (initialState?.fields) {
      for (const [key, val] of Object.entries(initialState.fields)) {
        this.fields.set(key, JSON.parse(JSON.stringify(val)));
      }
    }
  }

  private nextTimestamp(): LogicalTimestamp {
    this.logicalCounter += 1;
    return createTimestamp(this.nodeId, Date.now(), this.logicalCounter);
  }

  /**
   * Set a scalar/primitive value (LWW-Register) at the specified path.
   * Creates parent sub-documents along the path if they don't exist.
   */
  set(path: string | string[], value: unknown, customTimestamp?: LogicalTimestamp): DocumentPatch {
    const segments = normalizePath(path);
    if (segments.length === 0) {
      throw new Error('Path cannot be empty');
    }

    const ts = customTimestamp ?? this.nextTimestamp();
    const patch: DocumentPatch = {
      op: 'set_register',
      path: segments,
      value,
      timestamp: ts,
    };

    this.applyPatch(patch);
    return patch;
  }

  /**
   * Increment a PN-Counter at the specified path by amount (defaults to 1).
   */
  increment(path: string | string[], amount = 1): DocumentPatch {
    const segments = normalizePath(path);
    let deltaState: { P: Record<string, number>; N: Record<string, number> } = { P: {}, N: {} };

    this.mutateField(segments, (existing) => {
      const counter = new PNCounter(this.nodeId, existing?.type === 'counter' ? existing.state : undefined);
      deltaState = counter.increment(amount);
      return {
        type: 'counter',
        state: counter.state(),
      };
    });

    const patch: DocumentPatch = {
      op: 'counter_delta',
      path: segments,
      counterState: deltaState,
    };
    return patch;
  }

  /**
   * Decrement a PN-Counter at the specified path by amount (defaults to 1).
   */
  decrement(path: string | string[], amount = 1): DocumentPatch {
    return this.increment(path, -amount);
  }

  /**
   * Add an element to an OR-Set at the specified path.
   */
  addToSet(path: string | string[], element: unknown): DocumentPatch {
    const segments = normalizePath(path);
    this.logicalCounter += 1;
    const tag = `${this.nodeId}:${Date.now()}:${this.logicalCounter}:${Math.random().toString(36).slice(2, 8)}`;
    const patch: DocumentPatch = {
      op: 'add_to_set',
      path: segments,
      element,
      tag,
    };

    this.applyPatch(patch);
    return patch;
  }

  /**
   * Remove an element from an OR-Set at the specified path.
   */
  removeFromSet(path: string | string[], element: unknown): DocumentPatch {
    const segments = normalizePath(path);
    // Find all currently observed tags for this element
    const currentSet = this.resolveSet(segments);
    const tagsToRemove = currentSet ? currentSet.remove(element) : [];

    const patch: DocumentPatch = {
      op: 'remove_from_set',
      path: segments,
      element,
      tagsToRemove,
    };

    this.applyPatch(patch);
    return patch;
  }

  /**
   * Delete a field at path.
   */
  delete(path: string | string[]): DocumentPatch {
    const segments = normalizePath(path);
    const ts = this.nextTimestamp();
    const patch: DocumentPatch = {
      op: 'delete_field',
      path: segments,
      timestamp: ts,
    };
    this.applyPatch(patch);
    return patch;
  }

  /**
   * Retrieve scalar register value at path.
   */
  get<T = unknown>(path: string | string[]): T | undefined {
    const segments = normalizePath(path);
    const field = this.traverseField(segments);
    if (!field || field.type !== 'register') return undefined;
    return field.state.value as T;
  }

  /**
   * Retrieve counter value at path.
   */
  getCounter(path: string | string[]): number | undefined {
    const segments = normalizePath(path);
    const field = this.traverseField(segments);
    if (!field || field.type !== 'counter') return undefined;
    const counter = new PNCounter(this.nodeId, field.state);
    return counter.value();
  }

  /**
   * Retrieve active elements of OR-Set at path.
   */
  getSet<T = unknown>(path: string | string[]): T[] | undefined {
    const segments = normalizePath(path);
    const field = this.traverseField(segments);
    if (!field || field.type !== 'set') return undefined;
    const set = new ORSet<T>(this.nodeId, field.state as any);
    return set.read();
  }

  private traverseField(segments: string[]): DocumentFieldValue | undefined {
    if (segments.length === 0) return undefined;
    let currentMap = this.fields;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const field = currentMap.get(seg);
      if (!field) return undefined;

      if (i === segments.length - 1) {
        return field;
      }

      if (field.type === 'document') {
        const nextMap = new Map<string, DocumentFieldValue>(Object.entries(field.state.fields));
        currentMap = nextMap;
      } else {
        return undefined;
      }
    }
    return undefined;
  }

  private resolveSet(segments: string[]): ORSet | undefined {
    const field = this.traverseField(segments);
    if (field && field.type === 'set') {
      return new ORSet(this.nodeId, field.state);
    }
    return undefined;
  }

  /**
   * Apply a mutation patch locally or from a remote delta.
   */
  applyPatch(patch: DocumentPatch): void {
    if (patch.op === 'composite') {
      for (const p of patch.patches) {
        this.applyPatch(p);
      }
      return;
    }

    const { path } = patch;
    if (path.length === 0) return;

    if (patch.op === 'set_register') {
      this.mutateField(path, (existing) => {
        if (!existing || existing.type !== 'register') {
          return {
            type: 'register',
            state: { value: patch.value, timestamp: patch.timestamp },
          };
        }
        const reg = new LWWRegister(this.nodeId, existing.state.value, existing.state.timestamp);
        reg.merge({ value: patch.value, timestamp: patch.timestamp });
        return {
          type: 'register',
          state: reg.state(),
        };
      });
    } else if (patch.op === 'counter_delta') {
      this.mutateField(path, (existing) => {
        const counter = new PNCounter(this.nodeId, existing?.type === 'counter' ? existing.state : undefined);
        counter.merge(patch.counterState);
        return {
          type: 'counter',
          state: counter.state(),
        };
      });
    } else if (patch.op === 'increment_counter') {
      this.mutateField(path, (existing) => {
        const counter = new PNCounter(this.nodeId, existing?.type === 'counter' ? existing.state : undefined);
        if (patch.amount >= 0) {
          const currentP = counter.state().P[patch.nodeId] ?? 0;
          const mergedP = { ...counter.state().P, [patch.nodeId]: currentP + patch.amount };
          counter.merge({ P: mergedP, N: counter.state().N });
        } else {
          const currentN = counter.state().N[patch.nodeId] ?? 0;
          const mergedN = { ...counter.state().N, [patch.nodeId]: currentN + Math.abs(patch.amount) };
          counter.merge({ P: counter.state().P, N: mergedN });
        }
        return {
          type: 'counter',
          state: counter.state(),
        };
      });
    } else if (patch.op === 'add_to_set') {
      this.mutateField(path, (existing) => {
        const set = new ORSet(this.nodeId, existing?.type === 'set' ? existing.state : undefined);
        set.add(patch.element, patch.tag);
        return {
          type: 'set',
          state: set.state(),
        };
      });
    } else if (patch.op === 'remove_from_set') {
      this.mutateField(path, (existing) => {
        const set = new ORSet(this.nodeId, existing?.type === 'set' ? existing.state : undefined);
        set.merge({ adds: {}, tombstones: patch.tagsToRemove });
        return {
          type: 'set',
          state: set.state(),
        };
      });
    } else if (patch.op === 'delete_field') {
      this.deleteField(path, patch.timestamp);
    }
  }

  private mutateField(
    segments: string[],
    updateFn: (current: DocumentFieldValue | undefined) => DocumentFieldValue
  ): void {
    if (segments.length === 1) {
      const key = segments[0];
      const updated = updateFn(this.fields.get(key));
      this.fields.set(key, updated);
      return;
    }

    // Traverse and recursively build subdocuments
    const [head, ...tail] = segments;
    let headField = this.fields.get(head);
    let subDoc: DocumentCRDT;

    if (!headField || headField.type !== 'document') {
      subDoc = new DocumentCRDT(this.nodeId);
    } else {
      subDoc = new DocumentCRDT(this.nodeId, headField.state);
    }

    subDoc.mutateField(tail, updateFn);
    this.fields.set(head, {
      type: 'document',
      state: subDoc.state(),
    });
  }

  private deleteField(segments: string[], ts: LogicalTimestamp): void {
    if (segments.length === 1) {
      const key = segments[0];
      const existing = this.fields.get(key);
      if (existing && existing.type === 'register') {
        const reg = new LWWRegister(this.nodeId, existing.state.value, existing.state.timestamp);
        // Delete by setting null or tombstone with higher timestamp
        if (compareTimestamps(ts, existing.state.timestamp) > 0) {
          this.fields.delete(key);
        }
      } else {
        this.fields.delete(key);
      }
      return;
    }

    const [head, ...tail] = segments;
    const headField = this.fields.get(head);
    if (headField && headField.type === 'document') {
      const subDoc = new DocumentCRDT(this.nodeId, headField.state);
      subDoc.deleteField(tail, ts);
      this.fields.set(head, {
        type: 'document',
        state: subDoc.state(),
      });
    }
  }

  /**
   * Traverse all ORSets in document (including nested subdocuments) and prune stable tombstones.
   */
  pruneTombstones(tagsToPrune: Iterable<string>): number {
    let totalPruned = 0;
    for (const [, field] of this.fields.entries()) {
      if (field.type === 'set') {
        const set = new ORSet(this.nodeId, field.state as any);
        const count = set.pruneTombstones(tagsToPrune);
        if (count > 0) {
          field.state = set.state();
          totalPruned += count;
        }
      } else if (field.type === 'document') {
        const subDoc = new DocumentCRDT(this.nodeId, field.state);
        const count = subDoc.pruneTombstones(tagsToPrune);
        if (count > 0) {
          field.state = subDoc.state();
          totalPruned += count;
        }
      }
    }
    return totalPruned;
  }

  /**
   * Serialize current document state.
   */
  state(): DocumentState {
    const fieldsObj: Record<string, DocumentFieldValue> = {};
    for (const [k, v] of this.fields.entries()) {
      fieldsObj[k] = JSON.parse(JSON.stringify(v));
    }
    return { fields: fieldsObj };
  }

  /**
   * Merge external DocumentCRDT or state into this instance.
   */
  merge(other: DocumentState | DocumentCRDT): void {
    const remote = other instanceof DocumentCRDT ? other.state() : other;

    for (const [key, remoteField] of Object.entries(remote.fields)) {
      const localField = this.fields.get(key);

      if (!localField) {
        this.fields.set(key, JSON.parse(JSON.stringify(remoteField)));
        continue;
      }

      if (localField.type === 'register' && remoteField.type === 'register') {
        const merged = LWWRegister.merge(localField.state, remoteField.state);
        this.fields.set(key, { type: 'register', state: merged });
      } else if (localField.type === 'counter' && remoteField.type === 'counter') {
        const merged = PNCounter.merge(localField.state, remoteField.state);
        this.fields.set(key, { type: 'counter', state: merged });
      } else if (localField.type === 'set' && remoteField.type === 'set') {
        const merged = ORSet.merge(localField.state, remoteField.state);
        this.fields.set(key, { type: 'set', state: merged });
      } else if (localField.type === 'document' && remoteField.type === 'document') {
        const subDoc = new DocumentCRDT(this.nodeId, localField.state);
        subDoc.merge(remoteField.state);
        this.fields.set(key, { type: 'document', state: subDoc.state() });
      } else {
        // Conflicting types at same key: Deterministic tiebreaker (e.g. lexicographical by type)
        if (remoteField.type.localeCompare(localField.type) > 0) {
          this.fields.set(key, JSON.parse(JSON.stringify(remoteField)));
        }
      }
    }
  }

  /**
   * Export as clean JSON object.
   */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const sortedKeys = Array.from(this.fields.keys()).sort();
    for (const key of sortedKeys) {
      const field = this.fields.get(key)!;
      if (field.type === 'register') {
        out[key] = field.state.value;
      } else if (field.type === 'counter') {
        const counter = new PNCounter(this.nodeId, field.state);
        out[key] = counter.value();
      } else if (field.type === 'set') {
        const set = new ORSet(this.nodeId, field.state as any);
        out[key] = set.read();
      } else if (field.type === 'document') {
        const subDoc = new DocumentCRDT(this.nodeId, field.state);
        out[key] = subDoc.toJSON();
      }
    }
    return out;
  }

  /**
   * Clone this DocumentCRDT instance.
   */
  clone(nodeId: NodeId = this.nodeId): DocumentCRDT {
    return new DocumentCRDT(nodeId, this.state());
  }
}
