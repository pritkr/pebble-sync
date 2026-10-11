import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCausalHorizon,
  compactDAG,
  isCausallyDominated,
  pruneORSetTombstones,
  pruneDocumentTombstones,
} from '../src/merkle/compaction.js';
import { MerkleClock } from '../src/merkle/clock.js';
import { ORSet } from '../src/crdt/or_set.js';
import { DocumentCRDT } from '../src/crdt/document.js';
import { DeltaState, VectorClock } from '../src/types.js';

function createDummyDelta(id: string, nodeId: string, clock: VectorClock): DeltaState {
  return {
    deltaId: id,
    nodeId,
    clock,
    timestamp: { wallTime: Date.now(), counter: 0, nodeId },
    patch: { op: 'set_register', path: ['key'], value: id, timestamp: { wallTime: Date.now(), counter: 0, nodeId } },
  };
}

describe('Stable Causal Horizon & Compaction', () => {
  describe('computeCausalHorizon', () => {
    it('returns empty horizon for empty clock array', () => {
      assert.deepEqual(computeCausalHorizon([]), {});
    });

    it('returns copy of single peer clock', () => {
      const clock = { nodeA: 5, nodeB: 3 };
      assert.deepEqual(computeCausalHorizon([clock]), { nodeA: 5, nodeB: 3 });
    });

    it('computes pointwise minimum across multiple peer clocks', () => {
      const peerClocks: VectorClock[] = [
        { nodeA: 10, nodeB: 5, nodeC: 8 },
        { nodeA: 7,  nodeB: 8, nodeC: 8 },
        { nodeA: 8,  nodeB: 6, nodeC: 12 },
      ];

      const horizon = computeCausalHorizon(peerClocks);
      assert.deepEqual(horizon, {
        nodeA: 7,
        nodeB: 5,
        nodeC: 8,
      });
    });

    it('excludes nodeIds not yet observed by all active peers', () => {
      const peerClocks: VectorClock[] = [
        { nodeA: 5, nodeB: 3 },
        { nodeA: 4 }, // Peer 2 has not yet observed nodeB!
        { nodeA: 6, nodeB: 2 },
      ];

      const horizon = computeCausalHorizon(peerClocks);
      // nodeB is unacknowledged by Peer 2 (seq=0), so it cannot be in stable horizon
      assert.deepEqual(horizon, { nodeA: 4 });
    });
  });

  describe('isCausallyDominated', () => {
    it('correctly evaluates causal domination against horizon', () => {
      const horizon: VectorClock = { nodeA: 5, nodeB: 10 };

      assert.equal(isCausallyDominated({ nodeA: 3, nodeB: 8 }, horizon), true);
      assert.equal(isCausallyDominated({ nodeA: 5, nodeB: 10 }, horizon), true);
      assert.equal(isCausallyDominated({ nodeA: 6, nodeB: 8 }, horizon), false);
      assert.equal(isCausallyDominated({ nodeA: 3, nodeC: 1 }, horizon), false); // nodeC not in horizon
    });
  });

  describe('compactDAG', () => {
    it('prunes historical DAG nodes older than horizon while strictly preserving root hash invariant', () => {
      const dag = new MerkleClock('nodeA');

      // Create a chain of 10 commits
      for (let i = 1; i <= 10; i++) {
        dag.commit(createDummyDelta(`delta-${i}`, 'nodeA', { nodeA: i }));
      }

      assert.equal(dag.size(), 10);
      const originalRootHash = dag.getRootHash();
      const originalHeads = dag.getHeads();

      // Causal horizon acknowledged by all peers up to sequence 6
      const horizon: VectorClock = { nodeA: 6 };

      const result = compactDAG(dag, horizon);

      // Verify compaction metrics
      assert.equal(result.invariantVerified, true);
      assert.equal(result.rootHash, originalRootHash);
      assert.deepEqual(result.heads, originalHeads);
      assert.ok(result.prunedCount > 0);
      assert.ok(result.prunedNodeHashes.length > 0);
      assert.equal(result.remainingNodeCount, dag.size());
      assert.ok(dag.size() < 10);

      // Verify that heads were NOT pruned
      for (const head of originalHeads) {
        assert.ok(dag.getNode(head) !== undefined);
        assert.ok(!result.prunedNodeHashes.includes(head));
      }

      // Compacted snapshot base root is deterministic and content-addressed
      assert.ok(result.snapshot.baseSnapshotRoot.length === 64);
      assert.deepEqual(result.snapshot.horizon, horizon);
    });

    it('compacts multi-branch DAG frontiers preserving multi-head root continuity', () => {
      const dagA = new MerkleClock('nodeA');
      const dagB = new MerkleClock('nodeB');

      // Common base
      const root = dagA.commit(createDummyDelta('root', 'nodeA', { nodeA: 1 }));
      dagB.integrate(root);

      // Concurrent edits
      const nodeA1 = dagA.commit(createDummyDelta('editA', 'nodeA', { nodeA: 2 }));
      const nodeB1 = dagB.commit(createDummyDelta('editB', 'nodeB', { nodeB: 1 }));

      dagA.integrate(nodeB1);
      assert.equal(dagA.getHeads().length, 2);
      const originalMultiHeadRoot = dagA.getRootHash();

      // Horizon covers only the root commit (nodeA: 1)
      const horizon: VectorClock = { nodeA: 1, nodeB: 0 };
      const result = compactDAG(dagA, horizon);

      assert.equal(result.invariantVerified, true);
      assert.equal(dagA.getRootHash(), originalMultiHeadRoot);
      assert.equal(dagA.getHeads().length, 2);
      assert.ok(result.prunedNodeHashes.includes(root.hash));
    });
  });

  describe('Tombstone Garbage Collection', () => {
    it('prunes stable tombstones from ORSet and purges dead adds to reclaim memory', () => {
      const set = new ORSet<string>('nodeA');

      // Add elements
      const tag1 = set.add('Aspirin', 'nodeA:100:1:rand1');
      const tag2 = set.add('Paracetamol', 'nodeA:200:2:rand2');
      const tag3 = set.add('Amoxicillin', 'nodeA:300:3:rand3');

      assert.equal(set.size(), 3);
      assert.deepEqual(set.getTombstones(), []);

      // Remove Aspirin and Paracetamol
      const removed1 = set.remove('Aspirin');
      const removed2 = set.remove('Paracetamol');

      assert.deepEqual(removed1, [tag1]);
      assert.deepEqual(removed2, [tag2]);
      assert.equal(set.size(), 1);
      assert.deepEqual(set.read(), ['Amoxicillin']);
      assert.equal(set.getTombstones().length, 2);

      // Causal horizon reaches sequence 2 for nodeA (covers tag1 counter:1 and tag2 counter:2)
      const horizon: VectorClock = { nodeA: 2 };

      const { prunedTags, remainingTombstones } = pruneORSetTombstones(set, horizon);

      // Both tombstones should be garbage collected
      assert.equal(prunedTags.length, 2);
      assert.ok(prunedTags.includes(tag1));
      assert.ok(prunedTags.includes(tag2));
      assert.equal(remainingTombstones, 0);
      assert.deepEqual(set.getTombstones(), []);

      // Active elements remain intact
      assert.equal(set.size(), 1);
      assert.equal(set.has('Amoxicillin'), true);
      assert.equal(set.has('Aspirin'), false);

      // Internal adds record for Aspirin and Paracetamol should be completely purged
      const serialized = set.state();
      assert.equal(serialized.adds['string:Aspirin'], undefined);
      assert.equal(serialized.adds['string:Paracetamol'], undefined);
      assert.ok(serialized.adds['string:Amoxicillin'] !== undefined);

      // Adding Aspirin again in future works normally (Add-Wins with fresh tag)
      const freshTag = set.add('Aspirin');
      assert.equal(set.has('Aspirin'), true);
      assert.equal(set.size(), 2);
    });

    it('prunes tombstones across nested DocumentCRDT fields', () => {
      const doc = new DocumentCRDT('nodeA');

      // Add items to medical orders set inside document
      doc.addToSet(['patient', 'medications'], 'Insulin');
      doc.addToSet(['patient', 'medications'], 'Metformin');

      assert.deepEqual(doc.getSet(['patient', 'medications']), ['Insulin', 'Metformin']);

      // Remove Insulin
      doc.removeFromSet(['patient', 'medications'], 'Insulin');
      assert.deepEqual(doc.getSet(['patient', 'medications']), ['Metformin']);

      // Prune with tag clocks mapping
      const tagClocks = new Map<string, VectorClock>();
      // Find tombstone tag
      const docState = doc.state();
      const patientDoc = (docState.fields['patient'] as any).state;
      const medSet = patientDoc.fields['medications'].state;
      const tombstoneTag = medSet.tombstones[0];
      assert.ok(tombstoneTag);

      tagClocks.set(tombstoneTag, { nodeA: 1 });

      const horizon: VectorClock = { nodeA: 5 };
      const { prunedCount } = pruneDocumentTombstones(doc, horizon, { tagClocks });

      assert.equal(prunedCount, 1);
      assert.deepEqual(doc.getSet(['patient', 'medications']), ['Metformin']);
    });
  });
});
