/**
 * Pebble-Sync: Ultra-compact, offline-first state-based CRDT sync engine
 * with Merkle clocks, delta replication, and tamper-evident cryptographic hash chains.
 *
 * Version 2.0 Architectural Expansion:
 * - Stable Causal Compaction & Tombstone Garbage Collection
 * - Collaborative Sequence CRDT (Fugue-lite with fractional position identifiers)
 * - Real-Time WebSocket Sync Transport with Heartbeats & Auto-Reconnection
 */

// Core Types
export * from './types.js';

// CRDT Data Structures
export { PNCounter } from './crdt/pn_counter.js';
export { LWWRegister } from './crdt/lww_register.js';
export { ORSet } from './crdt/or_set.js';
export { DocumentCRDT, normalizePath } from './crdt/document.js';
export {
  SequenceCRDT,
  SequenceItem,
  SequenceState,
  SequenceOperation,
  PositionSegment,
  PositionKey,
  comparePositionKeys,
  compareSequenceItems,
  allocatePosition,
} from './crdt/sequence.js';

// Merkle Clock & DAG Engine
export { MerkleClock, MerkleDAG, canonicalJson, sha256 } from './merkle/clock.js';

// Stable Causal Horizon & Compaction
export {
  computeCausalHorizon,
  isCausallyDominated,
  compactDAG,
  parseTagMetadata,
  pruneORSetTombstones,
  pruneDocumentTombstones,
  CompactedDAGSnapshot,
  DAGCompactionResult,
} from './merkle/compaction.js';

// Cryptography & Tamper-Evident Hash Chain
export {
  AuditHashChain,
  AuditEntry,
  ChainVerificationResult,
  PebbleKeyPair,
  generatePebbleKeyPair,
  signDelta,
  verifySignedDelta,
  verifySignature,
  GENESIS_PREV_HASH,
} from './crypto/audit.js';

// Storage Adapters
export { StorageAdapter, StorageBatchOp } from './storage/interface.js';
export { MemoryStorageAdapter } from './storage/memory_adapter.js';
export { IndexedDBStorageAdapter, IndexedDBAdapterOptions } from './storage/indexeddb_adapter.js';

// Network Simulator
export { NetworkMesh, InFlightMessage } from './network/mesh.js';

// Real-Time WebSocket Transport
export {
  WebSocketSyncClient,
  WebSocketSyncClientOptions,
  WebSocketSyncServer,
  WebSocketSyncServerOptions,
  ConnectionState,
  WebSocketSyncFrame,
  WebSocketLike,
  createMockWebSocketPair,
} from './network/websocket_adapter.js';

// Sync Node Orchestrator
export { PebbleSyncNode, PebbleSyncNodeOptions } from './sync/orchestrator.js';
