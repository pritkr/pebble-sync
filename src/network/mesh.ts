import { canonicalJson } from '../merkle/clock.js';
import { PebbleSyncNode } from '../sync/orchestrator.js';
import { NodeId, SyncMessage } from '../types.js';

export interface InFlightMessage {
  id: string;
  from: NodeId;
  to: NodeId;
  message: SyncMessage;
  sentAt: number;
  deliverAt: number;
}

/**
 * NetworkMesh: In-Memory Multi-Node P2P Network Simulator
 * Simulates real-world rural/edge networking conditions:
 * - Network partitions (split-brain scenarios)
 * - Message delays / latency
 * - Packet loss / drops
 * - Partition healing and full eventual consistency verification
 */
export class NetworkMesh {
  private nodes = new Map<NodeId, PebbleSyncNode>();
  private messageQueue: InFlightMessage[] = [];
  private partitionMap = new Map<string, boolean>(); // key: `${from}->${to}`, value: canCommunicate
  private packetLossRate = 0; // 0.0 to 1.0
  private minLatencyMs = 0;
  private maxLatencyMs = 0;
  private messageCounter = 0;

  /**
   * Register a node in the mesh.
   */
  register(node: PebbleSyncNode): void {
    this.nodes.set(node.nodeId, node);
  }

  /**
   * Get node by NodeId.
   */
  getNode(nodeId: NodeId): PebbleSyncNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * All registered node IDs.
   */
  getNodeIds(): NodeId[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Configure packet loss rate between 0.0 (no drops) and 1.0 (drop all).
   */
  setPacketLoss(rate: number): void {
    this.packetLossRate = Math.max(0, Math.min(1, rate));
  }

  /**
   * Configure simulated network latency in milliseconds.
   */
  setLatency(minMs: number, maxMs: number): void {
    this.minLatencyMs = Math.max(0, minMs);
    this.maxLatencyMs = Math.max(minMs, maxMs);
  }

  /**
   * Partition the network into two mutually exclusive groups.
   * Nodes within groupA can talk to each other; nodes within groupB can talk to each other.
   * Cross-group communication is completely severed.
   */
  partition(groupA: NodeId[], groupB: NodeId[]): void {
    const setA = new Set(groupA);
    const setB = new Set(groupB);

    for (const a of setA) {
      for (const b of setB) {
        this.partitionMap.set(`${a}->${b}`, false);
        this.partitionMap.set(`${b}->${a}`, false);
      }
    }
  }

  /**
   * Isolate a single node from all other nodes in the network.
   */
  isolate(isolatedNodeId: NodeId): void {
    for (const id of this.nodes.keys()) {
      if (id !== isolatedNodeId) {
        this.partitionMap.set(`${isolatedNodeId}->${id}`, false);
        this.partitionMap.set(`${id}->${isolatedNodeId}`, false);
      }
    }
  }

  /**
   * Heal all network partitions, restoring 100% full mesh connectivity.
   */
  heal(): void {
    this.partitionMap.clear();
    this.packetLossRate = 0;
  }

  /**
   * Check if a link between two nodes is currently operational.
   */
  canCommunicate(from: NodeId, to: NodeId): boolean {
    const key = `${from}->${to}`;
    if (this.partitionMap.has(key)) {
      return this.partitionMap.get(key) === true;
    }
    return true;
  }

  /**
   * Send a protocol sync message from one node to another.
   */
  send(from: NodeId, to: NodeId, message: SyncMessage): boolean {
    if (!this.canCommunicate(from, to)) {
      return false; // Partitioned
    }

    if (this.packetLossRate > 0 && Math.random() < this.packetLossRate) {
      return false; // Dropped due to packet loss
    }

    const latency =
      this.maxLatencyMs > 0
        ? this.minLatencyMs + Math.random() * (this.maxLatencyMs - this.minLatencyMs)
        : 0;

    const inFlight: InFlightMessage = {
      id: `msg-${++this.messageCounter}`,
      from,
      to,
      message,
      sentAt: Date.now(),
      deliverAt: Date.now() + latency,
    };

    this.messageQueue.push(inFlight);
    return true;
  }

  /**
   * Deliver all queued messages and process responses until the network reaches quiescence.
   */
  async deliverAll(maxRounds = 50): Promise<number> {
    let deliveredCount = 0;
    let round = 0;

    while (this.messageQueue.length > 0 && round < maxRounds) {
      round++;
      const currentBatch = this.messageQueue.splice(0, this.messageQueue.length);

      for (const item of currentBatch) {
        if (!this.canCommunicate(item.from, item.to)) {
          continue; // Link severed while message was in transit
        }

        const recipient = this.nodes.get(item.to);
        const sender = this.nodes.get(item.from);
        if (!recipient || !sender) continue;

        deliveredCount++;
        const msg = item.message;

        if (msg.type === 'sync_offer') {
          const req = recipient.handleSyncOffer(msg);
          if (req) {
            this.send(recipient.nodeId, sender.nodeId, req);
          }
        } else if (msg.type === 'sync_request') {
          const resp = recipient.handleSyncRequest(msg);
          this.send(recipient.nodeId, sender.nodeId, resp);
        } else if (msg.type === 'sync_response') {
          await recipient.handleSyncResponse(msg);
        }
      }
    }

    return deliveredCount;
  }

  /**
   * Synchronize all mutually reachable nodes via gossip rounds until convergence.
   */
  async syncMesh(maxRounds = 5): Promise<{ rounds: number; converged: boolean }> {
    const nodeIds = this.getNodeIds();
    let round = 0;

    for (round = 1; round <= maxRounds; round++) {
      let anyMessagesSent = false;

      // Every node offers sync to every reachable peer
      for (const fromId of nodeIds) {
        for (const toId of nodeIds) {
          if (fromId === toId) continue;
          if (this.canCommunicate(fromId, toId)) {
            const sender = this.nodes.get(fromId)!;
            const offer = sender.createSyncOffer();
            if (this.send(fromId, toId, offer)) {
              anyMessagesSent = true;
            }
          }
        }
      }

      await this.deliverAll();

      if (this.verifyConvergence()) {
        return { rounds: round, converged: true };
      }

      if (!anyMessagesSent) break;
    }

    return {
      rounds: round,
      converged: this.verifyConvergence(),
    };
  }

  /**
   * Verify that all given nodes (or all nodes in the mesh) have identical state.
   */
  verifyConvergence(subsetNodeIds?: NodeId[]): boolean {
    const targets = subsetNodeIds ?? this.getNodeIds();
    if (targets.length <= 1) return true;

    const firstNode = this.nodes.get(targets[0])!;
    const expectedJson = canonicalJson(firstNode.toJSON());
    const expectedRoot = firstNode.merkleClock.getRootHash();

    for (let i = 1; i < targets.length; i++) {
      const node = this.nodes.get(targets[i]);
      if (!node) return false;

      const nodeJson = canonicalJson(node.toJSON());
      const nodeRoot = node.merkleClock.getRootHash();

      if (nodeJson !== expectedJson) {
        return false;
      }
      if (nodeRoot !== expectedRoot) {
        return false;
      }
    }

    return true;
  }
}
