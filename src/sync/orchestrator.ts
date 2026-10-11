import {
  AuditHashChain,
  generatePebbleKeyPair,
  PebbleKeyPair,
  signDelta,
  verifySignedDelta,
} from '../crypto/audit.js';
import { DocumentCRDT } from '../crdt/document.js';
import { MerkleClock } from '../merkle/clock.js';
import { MemoryStorageAdapter } from '../storage/memory_adapter.js';
import { StorageAdapter } from '../storage/interface.js';
import {
  DeltaState,
  DocumentPatch,
  LogicalTimestamp,
  NodeId,
  SignedDelta,
  SyncMessage,
  createTimestamp,
} from '../types.js';

export interface PebbleSyncNodeOptions {
  nodeId: NodeId;
  keyPair?: PebbleKeyPair;
  storage?: StorageAdapter;
}

/**
 * PebbleSyncNode
 * Orchestrates offline DocumentCRDT state, Merkle Clock DAG causal tracking,
 * tamper-evident cryptographic signatures, and peer synchronization.
 */
export class PebbleSyncNode {
  readonly nodeId: NodeId;
  readonly keyPair: PebbleKeyPair;
  readonly doc: DocumentCRDT;
  readonly merkleClock: MerkleClock;
  readonly auditChain: AuditHashChain;
  readonly storage: StorageAdapter;

  private signedDeltas = new Map<string, SignedDelta>();
  private logicalCounter = 0;

  constructor(options: PebbleSyncNodeOptions) {
    this.nodeId = options.nodeId;
    this.keyPair = options.keyPair ?? generatePebbleKeyPair();
    this.doc = new DocumentCRDT(this.nodeId);
    this.merkleClock = new MerkleClock(this.nodeId);
    this.auditChain = new AuditHashChain();
    this.storage = options.storage ?? new MemoryStorageAdapter();
  }

  private nextTimestamp(): LogicalTimestamp {
    this.logicalCounter += 1;
    return createTimestamp(this.nodeId, Date.now(), this.logicalCounter);
  }

  /**
   * Commit a document patch, create signed delta, record in Merkle clock, and persist.
   */
  async commitPatch(patch: DocumentPatch): Promise<SignedDelta> {
    const timestamp = this.nextTimestamp();
    const deltaId = `${this.nodeId}:${timestamp.wallTime}:${timestamp.counter}`;

    const delta: DeltaState = {
      deltaId,
      nodeId: this.nodeId,
      clock: this.merkleClock.getVectorClock(),
      timestamp,
      patch,
    };

    // Cryptographic signature chained to previous hash
    const latestAuditHash = this.auditChain.getLatestHash();
    const signedDelta = signDelta(delta, this.keyPair, latestAuditHash);

    // Append to tamper-evident audit chain
    this.auditChain.append(signedDelta, timestamp.wallTime);

    // Commit to Merkle Clock DAG
    this.merkleClock.commit(delta, timestamp.wallTime);

    // Cache signed delta
    this.signedDeltas.set(signedDelta.hash, signedDelta);

    // Persist to storage
    await this.persistState();

    return signedDelta;
  }

  // --- Document mutation shortcuts ---

  async set(path: string | string[], value: unknown): Promise<SignedDelta> {
    const segments = typeof path === 'string' ? path.split('.').filter(Boolean) : path;
    const ts = this.nextTimestamp();
    const patch: DocumentPatch = {
      op: 'set_register',
      path: segments,
      value,
      timestamp: ts,
    };
    this.doc.applyPatch(patch);
    return this.commitPatch(patch);
  }

  async increment(path: string | string[], amount = 1): Promise<SignedDelta> {
    const segments = typeof path === 'string' ? path.split('.').filter(Boolean) : path;
    const patch = this.doc.increment(segments, amount);
    return this.commitPatch(patch);
  }

  async decrement(path: string | string[], amount = 1): Promise<SignedDelta> {
    return this.increment(path, -amount);
  }

  async addToSet(path: string | string[], element: unknown): Promise<SignedDelta> {
    const segments = typeof path === 'string' ? path.split('.').filter(Boolean) : path;
    const tag = `${this.nodeId}:${Date.now()}:${++this.logicalCounter}:${Math.random().toString(36).slice(2, 7)}`;
    const patch: DocumentPatch = {
      op: 'add_to_set',
      path: segments,
      element,
      tag,
    };
    this.doc.applyPatch(patch);
    return this.commitPatch(patch);
  }

  async removeFromSet(path: string | string[], element: unknown): Promise<SignedDelta> {
    const segments = typeof path === 'string' ? path.split('.').filter(Boolean) : path;
    const patch = this.doc.removeFromSet(segments, element);
    return this.commitPatch(patch);
  }

  get<T = unknown>(path: string | string[]): T | undefined {
    return this.doc.get<T>(path);
  }

  getCounter(path: string | string[]): number | undefined {
    return this.doc.getCounter(path);
  }

  getSet<T = unknown>(path: string | string[]): T[] | undefined {
    return this.doc.getSet<T>(path);
  }

  toJSON(): Record<string, unknown> {
    return this.doc.toJSON();
  }

  // --- Persistence ---

  private async persistState(): Promise<void> {
    await this.storage.setJSON(`pebble:${this.nodeId}:doc`, this.doc.state());
    await this.storage.setJSON(`pebble:${this.nodeId}:frontier`, this.merkleClock.getFrontier());
    await this.storage.setJSON(`pebble:${this.nodeId}:audit_head`, this.auditChain.getLatestHash());
  }

  /**
   * Reload state from persistent storage adapter.
   */
  async loadFromStorage(): Promise<boolean> {
    const docState = await this.storage.getJSON<any>(`pebble:${this.nodeId}:doc`);
    if (docState) {
      this.doc.merge(docState);
      return true;
    }
    return false;
  }

  // --- Sync Protocol Methods ---

  createSyncOffer(): Extract<SyncMessage, { type: 'sync_offer' }> {
    return {
      type: 'sync_offer',
      nodeId: this.nodeId,
      heads: this.merkleClock.getHeads(),
      rootHash: this.merkleClock.getRootHash(),
      clock: this.merkleClock.getVectorClock(),
    };
  }

  handleSyncOffer(
    offer: Extract<SyncMessage, { type: 'sync_offer' }>
  ): Extract<SyncMessage, { type: 'sync_request' }> | null {
    if (offer.rootHash === this.merkleClock.getRootHash()) {
      return null; // Frontiers are identical, nothing missing
    }

    return {
      type: 'sync_request',
      nodeId: this.nodeId,
      knownHeads: this.merkleClock.getHeads(),
      targetHeads: offer.heads,
      clock: this.merkleClock.getVectorClock(),
    };
  }

  handleSyncRequest(
    request: Extract<SyncMessage, { type: 'sync_request' }>
  ): Extract<SyncMessage, { type: 'sync_response' }> {
    const missingNodes = this.merkleClock.computeMissingNodes(request.knownHeads, request.clock);
    const signedDeltas: SignedDelta[] = [];

    for (const node of missingNodes) {
      const delta = this.signedDeltas.get(node.deltaHash);
      if (delta) {
        signedDeltas.push(delta);
      }
    }

    return {
      type: 'sync_response',
      nodeId: this.nodeId,
      missingNodes,
      signedDeltas,
    };
  }

  async handleSyncResponse(
    response: Extract<SyncMessage, { type: 'sync_response' }>
  ): Promise<{ appliedCount: number; valid: boolean; error?: string }> {
    // 1. Verify signatures and cryptographic hashes of all incoming deltas
    for (const signedDelta of response.signedDeltas) {
      const verification = verifySignedDelta(signedDelta);
      if (!verification.valid) {
        return {
          appliedCount: 0,
          valid: false,
          error: `Tamper detected: ${verification.reason}`,
        };
      }
    }

    // 2. Apply deltas in causal order to local DocumentCRDT
    let appliedCount = 0;
    for (const signedDelta of response.signedDeltas) {
      if (this.signedDeltas.has(signedDelta.hash)) {
        continue;
      }
      this.doc.applyPatch(signedDelta.delta.patch);
      this.signedDeltas.set(signedDelta.hash, signedDelta);
      appliedCount++;
    }

    // 3. Integrate Merkle nodes into local Merkle Clock DAG
    for (const node of response.missingNodes) {
      this.merkleClock.integrate(node);
    }

    // 4. Persist updated convergent state
    await this.persistState();

    return { appliedCount, valid: true };
  }

  /**
   * Bi-directional direct synchronization between this node and a peer node.
   * Computes minimal diffs in both directions, transfers deltas, and verifies convergence.
   */
  async syncWithPeer(peer: PebbleSyncNode): Promise<{
    localApplied: number;
    peerApplied: number;
    converged: boolean;
  }> {
    // 1. Peer A -> Peer B sync
    const offerA = this.createSyncOffer();
    const reqB = peer.handleSyncOffer(offerA);
    let peerApplied = 0;
    if (reqB) {
      const respA = this.handleSyncRequest(reqB);
      const resultB = await peer.handleSyncResponse(respA);
      if (!resultB.valid) {
        throw new Error(`Sync rejected by peer: ${resultB.error}`);
      }
      peerApplied = resultB.appliedCount;
    }

    // 2. Peer B -> Peer A sync
    const offerB = peer.createSyncOffer();
    const reqA = this.handleSyncOffer(offerB);
    let localApplied = 0;
    if (reqA) {
      const respB = peer.handleSyncRequest(reqA);
      const resultA = await this.handleSyncResponse(respB);
      if (!resultA.valid) {
        throw new Error(`Sync rejected locally: ${resultA.error}`);
      }
      localApplied = resultA.appliedCount;
    }

    // Check if frontiers match
    const converged = this.merkleClock.getRootHash() === peer.merkleClock.getRootHash();

    return { localApplied, peerApplied, converged };
  }
}
