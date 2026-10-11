/**
 * Pebble-Sync Type Definitions
 * Ultra-compact offline-first CRDT types for edge and low-bandwidth environments.
 */

export type NodeId = string;

/**
 * Vector Clock mapping each NodeId to its logical sequence number.
 */
export type VectorClock = Record<NodeId, number>;

export type VectorClockComparison = 'equal' | 'before' | 'after' | 'concurrent';

/**
 * Hybrid Logical Timestamp providing strict total ordering.
 */
export interface LogicalTimestamp {
  wallTime: number; // Unix epoch milliseconds
  counter: number;  // Logical tick for same millisecond
  nodeId: NodeId;   // Deterministic tie-breaker
}

/**
 * Positive-Negative Counter CRDT state.
 * P tracks positive increments per node, N tracks negative decrements per node.
 */
export interface PNCounterState {
  P: Record<NodeId, number>;
  N: Record<NodeId, number>;
}

/**
 * Last-Write-Wins Register CRDT state.
 */
export interface LWWRegisterState<T = unknown> {
  value: T;
  timestamp: LogicalTimestamp;
}

/**
 * Observed-Remove Set (OR-Set) state.
 * Adds map deterministic element keys to their active unique tags.
 * Tombstones track removed tags.
 */
export interface ORSetState<T = unknown> {
  // key is deterministic string representation of element (or element itself if primitive)
  adds: Record<string, { value: T; tags: string[] }>;
  tombstones: string[];
}

/**
 * Supported field types in collaborative DocumentCRDT.
 */
export type DocumentFieldType = 'register' | 'counter' | 'set' | 'document';

export type DocumentFieldValue =
  | { type: 'register'; state: LWWRegisterState }
  | { type: 'counter'; state: PNCounterState }
  | { type: 'set'; state: ORSetState }
  | { type: 'document'; state: DocumentState };

export interface DocumentState {
  fields: Record<string, DocumentFieldValue>;
}

/**
 * Delta representation for partial CRDT updates.
 */
export interface DeltaState {
  deltaId: string;
  nodeId: NodeId;
  clock: VectorClock;
  timestamp: LogicalTimestamp;
  patch: DocumentPatch;
}

export type DocumentPatch =
  | { op: 'set_register'; path: string[]; value: unknown; timestamp: LogicalTimestamp }
  | { op: 'increment_counter'; path: string[]; amount: number; nodeId: NodeId }
  | { op: 'counter_delta'; path: string[]; counterState: PNCounterState }
  | { op: 'add_to_set'; path: string[]; element: unknown; tag: string }
  | { op: 'remove_from_set'; path: string[]; element: unknown; tagsToRemove: string[] }
  | { op: 'delete_field'; path: string[]; timestamp: LogicalTimestamp }
  | { op: 'composite'; patches: DocumentPatch[] };

/**
 * Cryptographically signed delta unit for tamper-evident replication.
 */
export interface SignedDelta {
  delta: DeltaState;
  authorPublicKey: string; // Hex-encoded or base64 Ed25519 public key
  signature: string;       // Hex-encoded Ed25519 signature of payload hash
  hash: string;            // SHA-256 hash of delta payload
  previousHash?: string;   // Chained hash from author's prior delta
}

/**
 * Merkle DAG Node: represents a causal commit in the Merkle Clock.
 */
export interface MerkleNode {
  hash: string;          // Cryptographic hash of this node: SHA256(parents + deltaHash + clock + timestamp + nodeId)
  parents: string[];     // Parent node hashes (DAG predecessors)
  deltaHash: string;     // Hash of associated delta
  clock: VectorClock;    // Accumulated causal vector clock
  nodeId: NodeId;        // Authoring node
  timestamp: number;     // Physical timestamp
  height: number;        // Height in DAG (max parent height + 1)
}

/**
 * Snapshot of Merkle Clock frontier.
 */
export interface MerkleFrontier {
  heads: string[];
  rootHash: string;
  clock: VectorClock;
}

/**
 * Protocol sync message shapes for peer-to-peer reconciliation.
 */
export type SyncMessage =
  | { type: 'sync_offer'; nodeId: NodeId; heads: string[]; rootHash: string; clock: VectorClock }
  | { type: 'sync_request'; nodeId: NodeId; knownHeads: string[]; targetHeads: string[]; clock?: VectorClock }
  | { type: 'sync_response'; nodeId: NodeId; missingNodes: MerkleNode[]; signedDeltas: SignedDelta[] }
  | { type: 'sync_ack'; nodeId: NodeId; rootHash: string };

/**
 * Vector Clock Helper Functions
 */
export function createVectorClock(initial?: Record<NodeId, number>): VectorClock {
  return initial ? { ...initial } : {};
}

export function vectorClockIncrement(clock: VectorClock, nodeId: NodeId, amount = 1): VectorClock {
  return {
    ...clock,
    [nodeId]: (clock[nodeId] ?? 0) + amount,
  };
}

export function vectorClockMerge(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = { ...a };
  for (const [k, v] of Object.entries(b)) {
    merged[k] = Math.max(merged[k] ?? 0, v);
  }
  return merged;
}

export function vectorClockCompare(a: VectorClock, b: VectorClock): VectorClockComparison {
  let aHasGreater = false;
  let bHasGreater = false;

  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of allKeys) {
    const valA = a[key] ?? 0;
    const valB = b[key] ?? 0;
    if (valA > valB) aHasGreater = true;
    if (valB > valA) bHasGreater = true;
  }

  if (aHasGreater && bHasGreater) return 'concurrent';
  if (aHasGreater) return 'after';
  if (bHasGreater) return 'before';
  return 'equal';
}

export function vectorClockDominatesOrEqual(a: VectorClock, b: VectorClock): boolean {
  for (const [k, v] of Object.entries(b)) {
    if ((a[k] ?? 0) < v) return false;
  }
  return true;
}

/**
 * Logical Timestamp Helper Functions
 */
export function createTimestamp(nodeId: NodeId, wallTime = Date.now(), counter = 0): LogicalTimestamp {
  return { wallTime, counter, nodeId };
}

export function compareTimestamps(a: LogicalTimestamp, b: LogicalTimestamp): number {
  if (a.wallTime !== b.wallTime) {
    return a.wallTime - b.wallTime;
  }
  if (a.counter !== b.counter) {
    return a.counter - b.counter;
  }
  return a.nodeId.localeCompare(b.nodeId);
}
