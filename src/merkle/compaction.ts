import { MerkleClock, canonicalJson, sha256 } from './clock.js';
import { ORSet } from '../crdt/or_set.js';
import { DocumentCRDT } from '../crdt/document.js';
import {
  NodeId,
  VectorClock,
  vectorClockDominatesOrEqual,
} from '../types.js';

export type MerkleDAG = MerkleClock;

/**
 * Snapshot of a compacted DAG base horizon.
 */
export interface CompactedDAGSnapshot {
  horizon: VectorClock;
  baseSnapshotRoot: string;
  heads: string[];
  rootHash: string;
  compactedAt: number;
}

/**
 * Result returned after DAG compaction.
 */
export interface DAGCompactionResult {
  snapshot: CompactedDAGSnapshot;
  prunedNodeHashes: string[];
  prunedCount: number;
  remainingNodeCount: number;
  heads: string[];
  rootHash: string;
  invariantVerified: boolean;
}

/**
 * Computes the minimum stable vector timestamp acknowledged by all active peers.
 * In a distributed cluster, an operation is causally stable (safe for garbage collection)
 * if and only if every active peer has acknowledged observing it.
 *
 * Mathematically: Horizon[k] = min_{c in peerClocks} (c[k] ?? 0)
 * If any peer has not observed nodeId k at all, then Horizon[k] = 0.
 */
export function computeCausalHorizon(peerClocks: VectorClock[]): VectorClock {
  if (peerClocks.length === 0) return {};
  if (peerClocks.length === 1) return { ...peerClocks[0] };

  // Collect all known node IDs across all active peer vector clocks
  const allNodeIds = new Set<NodeId>();
  for (const clock of peerClocks) {
    for (const id of Object.keys(clock)) {
      allNodeIds.add(id);
    }
  }

  const horizon: VectorClock = {};
  for (const nodeId of allNodeIds) {
    let minSeq = Infinity;
    for (const clock of peerClocks) {
      const seq = clock[nodeId] ?? 0;
      if (seq < minSeq) {
        minSeq = seq;
      }
    }
    // Only include positive, universally acknowledged sequence numbers
    if (minSeq > 0 && minSeq !== Infinity) {
      horizon[nodeId] = minSeq;
    }
  }

  return horizon;
}

/**
 * Determine if a vector clock is causally dominated by the given causal horizon.
 * A clock is dominated if for all nodeId keys in clock: clock[nodeId] <= (horizon[nodeId] ?? 0).
 */
export function isCausallyDominated(clock: VectorClock, horizon: VectorClock): boolean {
  for (const [nodeId, seq] of Object.entries(clock)) {
    const horizonSeq = horizon[nodeId] ?? 0;
    if (seq > horizonSeq) {
      return false;
    }
  }
  return true;
}

/**
 * Compacts a Merkle DAG by pruning historical nodes older than the causal horizon
 * into a compacted base snapshot while strictly preserving cryptographic root hash invariants.
 *
 * Invariant: DAG heads must never be removed, ensuring getRootHash() remains identical.
 */
export function compactDAG(dag: MerkleDAG, horizon: VectorClock): DAGCompactionResult {
  const originalRootHash = dag.getRootHash();
  const currentHeads = new Set(dag.getHeads());
  const allNodes = dag.getAllNodes();

  const prunedNodeHashes: string[] = [];

  for (const node of allNodes) {
    // Invariant: Never prune the current DAG heads
    if (currentHeads.has(node.hash)) {
      continue;
    }

    // Prune if this node's causal clock is dominated by the causal horizon
    if (isCausallyDominated(node.clock, horizon)) {
      prunedNodeHashes.push(node.hash);
    }
  }

  // Execute pruning on the DAG
  const prunedCount = dag.pruneNodes(prunedNodeHashes);

  // Compute deterministic base snapshot root for the compacted historical lineage
  const sortedPrunedHashes = prunedNodeHashes.slice().sort();
  const snapshotPayload = canonicalJson({
    horizon,
    prunedHashes: sortedPrunedHashes,
    retainedHeads: dag.getHeads(),
  });
  const baseSnapshotRoot = sha256(snapshotPayload);

  const newRootHash = dag.getRootHash();
  const invariantVerified = newRootHash === originalRootHash;

  const snapshot: CompactedDAGSnapshot = {
    horizon: { ...horizon },
    baseSnapshotRoot,
    heads: dag.getHeads(),
    rootHash: newRootHash,
    compactedAt: Date.now(),
  };

  return {
    snapshot,
    prunedNodeHashes: sortedPrunedHashes,
    prunedCount,
    remainingNodeCount: dag.size(),
    heads: dag.getHeads(),
    rootHash: newRootHash,
    invariantVerified,
  };
}

/**
 * Tag metadata parser for Pebble tags.
 * Pebble standard tag format: `${nodeId}:${timestamp}:${counter}:${random}`
 */
export function parseTagMetadata(tag: string): { nodeId: NodeId; timestamp?: number; counter?: number } | null {
  const parts = tag.split(':');
  if (parts.length >= 2) {
    const nodeId = parts[0];
    const timestamp = Number(parts[1]);
    const counter = parts.length >= 3 ? Number(parts[2]) : undefined;
    return {
      nodeId,
      timestamp: isNaN(timestamp) ? undefined : timestamp,
      counter: isNaN(counter ?? NaN) ? undefined : counter,
    };
  }
  return null;
}

/**
 * Prune tombstones from an ORSet that are causally stable under the given horizon.
 * When a tombstone has been acknowledged by all peers in the causal horizon, no replica
 * will ever re-transmit that tag, so it can be safely purged from both tombstones and adds.
 */
export function pruneORSetTombstones<T = unknown>(
  orSet: ORSet<T>,
  horizon: VectorClock,
  options?: {
    tagClocks?: Map<string, VectorClock>;
    isStableTag?: (tag: string) => boolean;
  }
): { prunedTags: string[]; remainingTombstones: number } {
  const currentTombstones = orSet.getTombstones();
  const tagsToPrune: string[] = [];

  for (const tag of currentTombstones) {
    let stable = false;

    // Check custom predicate if provided
    if (options?.isStableTag) {
      stable = options.isStableTag(tag);
    } else if (options?.tagClocks && options.tagClocks.has(tag)) {
      // Check if associated vector clock is dominated by horizon
      const clock = options.tagClocks.get(tag)!;
      stable = isCausallyDominated(clock, horizon);
    } else {
      // Fallback: parse tag metadata
      const meta = parseTagMetadata(tag);
      if (meta && meta.counter !== undefined) {
        const horizonSeq = horizon[meta.nodeId] ?? 0;
        if (meta.counter <= horizonSeq) {
          stable = true;
        }
      }
    }

    if (stable) {
      tagsToPrune.push(tag);
    }
  }

  orSet.pruneTombstones(tagsToPrune);

  return {
    prunedTags: tagsToPrune,
    remainingTombstones: orSet.getTombstones().length,
  };
}

/**
 * Prune tombstones from all ORSets in a DocumentCRDT older than the causal horizon.
 */
export function pruneDocumentTombstones(
  doc: DocumentCRDT,
  horizon: VectorClock,
  options?: {
    tagClocks?: Map<string, VectorClock>;
    isStableTag?: (tag: string) => boolean;
  }
): { prunedCount: number } {
  // Find all stable tags
  const tagsToPrune: string[] = [];

  // If explicit stable tags are identifiable via options
  if (options?.tagClocks) {
    for (const [tag, clock] of options.tagClocks.entries()) {
      if (isCausallyDominated(clock, horizon)) {
        tagsToPrune.push(tag);
      }
    }
  }

  if (tagsToPrune.length > 0) {
    const prunedCount = doc.pruneTombstones(tagsToPrune);
    return { prunedCount };
  }

  return { prunedCount: 0 };
}
