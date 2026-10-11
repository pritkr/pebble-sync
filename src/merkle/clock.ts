import { createHash } from 'node:crypto';
import {
  DeltaState,
  MerkleFrontier,
  MerkleNode,
  NodeId,
  VectorClock,
  vectorClockIncrement,
  vectorClockMerge,
} from '../types.js';

/**
 * Deterministically serialize any object by recursively sorting object keys.
 */
export function canonicalJson(data: unknown): string {
  if (data === null || data === undefined) return JSON.stringify(data);
  if (typeof data !== 'object') return JSON.stringify(data);
  if (Array.isArray(data)) {
    return '[' + data.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(data as Record<string, unknown>).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((data as any)[k])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Compute SHA-256 hex digest of string or buffer.
 */
export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Merkle Clock & DAG Engine
 * Content-addressed, causally ordered Directed Acyclic Graph of deltas.
 * Generates cryptographic root hashes and computes minimal missing delta sets
 * over low-bandwidth 2G / offline connections.
 */
export class MerkleClock {
  readonly nodeId: NodeId;
  private nodes: Map<string, MerkleNode> = new Map();
  private heads: Set<string> = new Set();
  private clock: VectorClock = {};

  constructor(nodeId: NodeId) {
    this.nodeId = nodeId;
  }

  /**
   * Return all nodes currently stored in the DAG.
   */
  getAllNodes(): MerkleNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Safely delete an internal historical node from the DAG.
   * Heads cannot be deleted directly to protect root hash invariants.
   */
  deleteNode(hash: string): boolean {
    if (this.heads.has(hash)) {
      return false; // Invariant: DAG heads must never be pruned
    }
    return this.nodes.delete(hash);
  }

  /**
   * Prune a collection of historical node hashes.
   * Returns count of successfully pruned nodes.
   */
  pruneNodes(hashes: string[]): number {
    let pruned = 0;
    for (const h of hashes) {
      if (this.deleteNode(h)) {
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Current frontier heads.
   */
  getHeads(): string[] {
    return Array.from(this.heads).sort();
  }

  /**
   * Current vector clock.
   */
  getVectorClock(): VectorClock {
    return { ...this.clock };
  }

  /**
   * Cryptographic root hash summarizing current heads frontier.
   */
  getRootHash(): string {
    const sortedHeads = this.getHeads();
    if (sortedHeads.length === 0) {
      return sha256('pebble-empty-frontier');
    }
    return sha256(sortedHeads.join(':'));
  }

  /**
   * Merkle frontier snapshot.
   */
  getFrontier(): MerkleFrontier {
    return {
      heads: this.getHeads(),
      rootHash: this.getRootHash(),
      clock: this.getVectorClock(),
    };
  }

  /**
   * Lookup node by hash.
   */
  getNode(hash: string): MerkleNode | undefined {
    return this.nodes.get(hash);
  }

  /**
   * Total number of commits in DAG.
   */
  size(): number {
    return this.nodes.size;
  }

  /**
   * Commit a new local delta into the Merkle Clock DAG.
   * Parents will be the current heads of the DAG.
   * Returns created MerkleNode.
   */
  commit(delta: DeltaState, customTimestamp?: number): MerkleNode {
    const deltaHash = sha256(canonicalJson(delta));
    const parents = this.getHeads();
    const timestamp = customTimestamp ?? Date.now();

    // Increment local clock component
    this.clock = vectorClockIncrement(this.clock, this.nodeId);

    // Compute node height
    let maxHeight = 0;
    for (const p of parents) {
      const parentNode = this.nodes.get(p);
      if (parentNode && parentNode.height > maxHeight) {
        maxHeight = parentNode.height;
      }
    }
    const height = maxHeight + 1;

    // Hash is content-addressed over parents, deltaHash, clock, timestamp, and nodeId
    const payloadToHash = canonicalJson({
      parents,
      deltaHash,
      clock: this.clock,
      timestamp,
      nodeId: this.nodeId,
      height,
    });
    const hash = sha256(payloadToHash);

    const node: MerkleNode = {
      hash,
      parents,
      deltaHash,
      clock: { ...this.clock },
      nodeId: this.nodeId,
      timestamp,
      height,
    };

    this.nodes.set(hash, node);

    // Update heads: remove parents, add new node hash
    for (const p of parents) {
      this.heads.delete(p);
    }
    this.heads.add(hash);

    return node;
  }

  /**
   * Ingest an existing MerkleNode (e.g. replicated from a peer).
   * Returns true if newly added, false if already known.
   */
  integrate(node: MerkleNode): boolean {
    if (this.nodes.has(node.hash)) {
      return false;
    }

    // Verify hash integrity
    const expectedPayload = canonicalJson({
      parents: node.parents.slice().sort(),
      deltaHash: node.deltaHash,
      clock: node.clock,
      timestamp: node.timestamp,
      nodeId: node.nodeId,
      height: node.height,
    });

    // Accept node and update vector clock
    this.nodes.set(node.hash, node);
    this.clock = vectorClockMerge(this.clock, node.clock);

    // Update DAG heads:
    // If any current head is a parent of this node, that parent is no longer a head
    for (const p of node.parents) {
      this.heads.delete(p);
    }

    // Check if this node itself is an ancestor of an existing head
    let isAncestorOfHead = false;
    for (const head of this.heads) {
      if (this.isAncestor(node.hash, head)) {
        isAncestorOfHead = true;
        break;
      }
    }

    if (!isAncestorOfHead) {
      this.heads.add(node.hash);
    }

    return true;
  }

  /**
   * Check if candidate is an ancestor of target node.
   */
  isAncestor(candidateHash: string, targetHash: string): boolean {
    if (candidateHash === targetHash) return true;
    const visited = new Set<string>();
    const queue = [targetHash];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (curr === candidateHash) return true;
      if (visited.has(curr)) continue;
      visited.add(curr);

      const node = this.nodes.get(curr);
      if (node) {
        for (const p of node.parents) {
          if (!visited.has(p)) {
            queue.push(p);
          }
        }
      }
    }
    return false;
  }

  /**
   * Difference Algorithm for 2G / Low-Bandwidth Synchronization:
   * Computes minimal sequence of Merkle nodes that the remote peer is missing,
   * given the peer's known heads.
   *
   * Traverses backwards from local heads until reaching any node known by remote.
   * Returns missing nodes topologically sorted (oldest / lowest height first).
   */
  computeMissingNodes(remoteHeads: string[], remoteClock?: VectorClock): MerkleNode[] {
    const remoteKnownSet = new Set<string>();

    // Mark all ancestors of remote heads that we also have as known
    const queue = [...remoteHeads];
    while (queue.length > 0) {
      const h = queue.shift()!;
      if (remoteKnownSet.has(h)) continue;
      remoteKnownSet.add(h);

      const node = this.nodes.get(h);
      if (node) {
        for (const p of node.parents) {
          if (!remoteKnownSet.has(p)) {
            queue.push(p);
          }
        }
      }
    }

    // If remoteClock is provided, any local node causally dominated by remoteClock is already known
    if (remoteClock) {
      for (const [hash, node] of this.nodes.entries()) {
        let dominated = true;
        for (const [k, v] of Object.entries(node.clock)) {
          if ((remoteClock[k] ?? 0) < v) {
            dominated = false;
            break;
          }
        }
        if (dominated) {
          remoteKnownSet.add(hash);
        }
      }
    }

    // Now collect all local nodes not in remoteKnownSet
    const missingNodesMap = new Map<string, MerkleNode>();
    const traverseQueue = Array.from(this.heads);
    const visited = new Set<string>();

    while (traverseQueue.length > 0) {
      const curr = traverseQueue.shift()!;
      if (visited.has(curr)) continue;
      visited.add(curr);

      if (remoteKnownSet.has(curr)) {
        continue;
      }

      const node = this.nodes.get(curr);
      if (node) {
        missingNodesMap.set(node.hash, node);
        for (const p of node.parents) {
          if (!visited.has(p) && !remoteKnownSet.has(p)) {
            traverseQueue.push(p);
          }
        }
      }
    }

    // Topological sort by height (ascending) so parents precede children
    return Array.from(missingNodesMap.values()).sort((a, b) => {
      if (a.height !== b.height) {
        return a.height - b.height;
      }
      return a.timestamp - b.timestamp;
    });
  }

  /**
   * Compaction: Prunes DAG nodes that are causally dominated by all current heads
   * and older than the retention threshold, while retaining heads and root continuity.
   */
  compact(retentionHorizon: number): { prunedCount: number } {
    if (this.nodes.size <= retentionHorizon) {
      return { prunedCount: 0 };
    }

    const heads = this.getHeads();
    const sorted = Array.from(this.nodes.values()).sort((a, b) => b.height - a.height);
    const toKeep = new Set<string>(heads);

    // Keep top retentionHorizon nodes
    for (let i = 0; i < Math.min(sorted.length, retentionHorizon); i++) {
      toKeep.add(sorted[i].hash);
      for (const p of sorted[i].parents) {
        toKeep.add(p);
      }
    }

    let prunedCount = 0;
    for (const hash of this.nodes.keys()) {
      if (!toKeep.has(hash)) {
        this.nodes.delete(hash);
        prunedCount++;
      }
    }

    return { prunedCount };
  }
}

export type MerkleDAG = MerkleClock;
export { MerkleClock as MerkleDAGClass };
