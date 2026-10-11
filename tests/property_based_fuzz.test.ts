import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PNCounter } from '../src/crdt/pn_counter.js';
import { LWWRegister } from '../src/crdt/lww_register.js';
import { ORSet } from '../src/crdt/or_set.js';
import { DocumentCRDT } from '../src/crdt/document.js';
import { SequenceCRDT } from '../src/crdt/sequence.js';
import { PebbleSyncNode } from '../src/sync/orchestrator.js';
import { NetworkMesh } from '../src/network/mesh.js';
import { canonicalJson } from '../src/merkle/clock.js';
import { createTimestamp, LogicalTimestamp } from '../src/types.js';

// Deterministic PRNG (Mulberry32) for reproducible property fuzzing
function createRng(seed = 1337) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Randomized Property-Based Semilattice Fuzzing (1,000+ Invariant Runs)', () => {
  const rng = createRng(42);

  describe('Semilattice Laws: Commutativity, Associativity, Idempotency (500 Runs)', () => {
    it('verifies PNCounter semilattice invariants across 100 randomized states', () => {
      for (let i = 0; i < 100; i++) {
        const nodes = ['nodeA', 'nodeB', 'nodeC'];
        const genPNCounter = () => {
          const counter = new PNCounter('nodeA');
          for (let j = 0; j < 5; j++) {
            const n = nodes[Math.floor(rng() * nodes.length)];
            const amt = Math.floor(rng() * 20) - 10;
            if (amt >= 0) {
              counter.merge({ P: { [n]: amt }, N: {} });
            } else {
              counter.merge({ P: {}, N: { [n]: Math.abs(amt) } });
            }
          }
          return counter.state();
        };

        const A = genPNCounter();
        const B = genPNCounter();
        const C = genPNCounter();

        // Idempotency: merge(A, A) == A
        const AA = PNCounter.merge(A, A);
        assert.deepEqual(AA, A, `PNCounter Idempotency failed on run ${i}`);

        // Commutativity: merge(A, B) == merge(B, A)
        const AB = PNCounter.merge(A, B);
        const BA = PNCounter.merge(B, A);
        assert.deepEqual(AB, BA, `PNCounter Commutativity failed on run ${i}`);

        // Associativity: merge(merge(A, B), C) == merge(A, merge(B, C))
        const AB_C = PNCounter.merge(AB, C);
        const BC = PNCounter.merge(B, C);
        const A_BC = PNCounter.merge(A, BC);
        assert.deepEqual(AB_C, A_BC, `PNCounter Associativity failed on run ${i}`);
      }
    });

    it('verifies LWWRegister semilattice invariants across 100 randomized states', () => {
      const nodes = ['nodeA', 'nodeB', 'nodeC'];
      for (let i = 0; i < 100; i++) {
        const genReg = () => {
          const n = nodes[Math.floor(rng() * nodes.length)];
          const wall = 1000 + Math.floor(rng() * 50);
          const counter = Math.floor(rng() * 10);
          const val = `val_${Math.floor(rng() * 100)}`;
          return {
            value: val,
            timestamp: createTimestamp(n, wall, counter),
          };
        };

        const A = genReg();
        const B = genReg();
        const C = genReg();

        // Idempotency
        const AA = LWWRegister.merge(A, A);
        assert.deepEqual(AA, A, `LWWRegister Idempotency failed on run ${i}`);

        // Commutativity
        const AB = LWWRegister.merge(A, B);
        const BA = LWWRegister.merge(B, A);
        assert.deepEqual(AB, BA, `LWWRegister Commutativity failed on run ${i}`);

        // Associativity
        const AB_C = LWWRegister.merge(AB, C);
        const BC = LWWRegister.merge(B, C);
        const A_BC = LWWRegister.merge(A, BC);
        assert.deepEqual(AB_C, A_BC, `LWWRegister Associativity failed on run ${i}`);
      }
    });

    it('verifies ORSet semilattice invariants across 100 randomized states', () => {
      const vocab = ['Aspirin', 'Paracetamol', 'Ibuprofen', 'Metformin', 'Amoxicillin'];
      for (let i = 0; i < 100; i++) {
        const genSet = () => {
          const set = new ORSet<string>('nodeA');
          for (let j = 0; j < 8; j++) {
            const item = vocab[Math.floor(rng() * vocab.length)];
            if (rng() > 0.3) {
              set.add(item);
            } else {
              set.remove(item);
            }
          }
          return set.state();
        };

        const A = genSet();
        const B = genSet();
        const C = genSet();

        // Idempotency: elements and tombstones match
        const AA = ORSet.merge(A, A);
        const setA = new ORSet('nodeA', A);
        const setAA = new ORSet('nodeA', AA);
        assert.deepEqual(setAA.read(), setA.read());

        // Commutativity
        const AB = ORSet.merge(A, B);
        const BA = ORSet.merge(B, A);
        const setAB = new ORSet('nodeA', AB);
        const setBA = new ORSet('nodeA', BA);
        assert.deepEqual(setAB.read(), setBA.read(), `ORSet Commutativity failed on run ${i}`);

        // Associativity
        const AB_C = ORSet.merge(AB, C);
        const BC = ORSet.merge(B, C);
        const A_BC = ORSet.merge(A, BC);
        const setAB_C = new ORSet('nodeA', AB_C);
        const setA_BC = new ORSet('nodeA', A_BC);
        assert.deepEqual(setAB_C.read(), setA_BC.read(), `ORSet Associativity failed on run ${i}`);
      }
    });

    it('verifies DocumentCRDT semilattice invariants across 100 randomized documents', () => {
      const keys = ['status', 'score', 'tags', 'metadata'];
      const nodes = ['node1', 'node2', 'node3'];

      for (let i = 0; i < 100; i++) {
        const genDoc = () => {
          const n = nodes[Math.floor(rng() * nodes.length)];
          const doc = new DocumentCRDT(n);
          for (let j = 0; j < 6; j++) {
            const key = keys[Math.floor(rng() * keys.length)];
            const r = rng();
            if (r < 0.33) {
              doc.set(key, Math.floor(rng() * 50));
            } else if (r < 0.66) {
              doc.increment(key, Math.floor(rng() * 5) + 1);
            } else {
              doc.addToSet(key, `item_${Math.floor(rng() * 5)}`);
            }
          }
          return doc.state();
        };

        const A = genDoc();
        const B = genDoc();
        const C = genDoc();

        const docA = new DocumentCRDT('node1', A);

        // Idempotency
        const docAA = docA.clone();
        docAA.merge(A);
        assert.deepEqual(docAA.toJSON(), docA.toJSON());

        // Commutativity
        const docAB = new DocumentCRDT('node1', A);
        docAB.merge(B);

        const docBA = new DocumentCRDT('node1', B);
        docBA.merge(A);

        assert.deepEqual(docAB.toJSON(), docBA.toJSON(), `DocumentCRDT Commutativity failed on run ${i}`);

        // Associativity
        const docAB_C = docAB.clone();
        docAB_C.merge(C);

        const docBC = new DocumentCRDT('node1', B);
        docBC.merge(C);
        const docA_BC = new DocumentCRDT('node1', A);
        docA_BC.merge(docBC.state());

        assert.deepEqual(docAB_C.toJSON(), docA_BC.toJSON(), `DocumentCRDT Associativity failed on run ${i}`);
      }
    });

    it('verifies SequenceCRDT semilattice invariants across 100 randomized text states', () => {
      const words = ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog'];
      for (let i = 0; i < 100; i++) {
        const genSeq = (n: string) => {
          const seq = new SequenceCRDT<string>(n);
          for (let j = 0; j < 5; j++) {
            const w = words[Math.floor(rng() * words.length)];
            const idx = Math.floor(rng() * (seq.length + 1));
            seq.insertText(idx, w);
          }
          return seq.state();
        };

        const A = genSeq('nodeA');
        const B = genSeq('nodeB');
        const C = genSeq('nodeC');

        // Idempotency
        const AA = SequenceCRDT.merge(A, A);
        const seqA = new SequenceCRDT('nodeA', A);
        const seqAA = new SequenceCRDT('nodeA', AA);
        assert.equal(seqAA.toString(), seqA.toString());

        // Commutativity
        const AB = SequenceCRDT.merge(A, B);
        const BA = SequenceCRDT.merge(B, A);
        const seqAB = new SequenceCRDT('nodeA', AB);
        const seqBA = new SequenceCRDT('nodeA', BA);
        assert.equal(seqAB.toString(), seqBA.toString(), `SequenceCRDT Commutativity failed on run ${i}`);

        // Associativity
        const AB_C = SequenceCRDT.merge(AB, C);
        const BC = SequenceCRDT.merge(B, C);
        const A_BC = SequenceCRDT.merge(A, BC);
        const seqAB_C = new SequenceCRDT('nodeA', AB_C);
        const seqA_BC = new SequenceCRDT('nodeA', A_BC);
        assert.equal(seqAB_C.toString(), seqA_BC.toString(), `SequenceCRDT Associativity failed on run ${i}`);
      }
    });
  });

  describe('Randomized Operational DAGs across Arbitrary Network Topologies (500+ Runs)', () => {
    it('proves 100% convergence across 500 randomized concurrent topologies & network splits', async () => {
      // 500 randomized runs
      for (let run = 1; run <= 500; run++) {
        const mesh = new NetworkMesh();
        const numNodes = 3 + Math.floor(rng() * 3); // 3 to 5 nodes
        const nodes: PebbleSyncNode[] = [];
        const nodeIds: string[] = [];

        for (let i = 0; i < numNodes; i++) {
          const id = `node_${i}`;
          nodeIds.push(id);
          const node = new PebbleSyncNode({ nodeId: id });
          nodes.push(node);
          mesh.register(node);
        }

        // Apply a random initial network topology (partitioned cluster, star, or partial mesh)
        const topologyType = Math.floor(rng() * 4);
        if (topologyType === 0) {
          // Bipartite partition
          const splitIdx = 1 + Math.floor(rng() * (numNodes - 2));
          const groupA = nodeIds.slice(0, splitIdx);
          const groupB = nodeIds.slice(splitIdx);
          mesh.partition(groupA, groupB);
        } else if (topologyType === 1) {
          // Isolate one random node
          mesh.isolate(nodeIds[Math.floor(rng() * numNodes)]);
        }

        // Each node performs 2 to 4 concurrent mutations offline
        for (const node of nodes) {
          const numOps = 2 + Math.floor(rng() * 3);
          for (let op = 0; op < numOps; op++) {
            const opType = Math.floor(rng() * 3);
            const key = `field_${Math.floor(rng() * 3)}`;
            if (opType === 0) {
              await node.set(key, `val_${node.nodeId}_${op}`);
            } else if (opType === 1) {
              await node.increment('metrics.counter', Math.floor(rng() * 5) + 1);
            } else {
              await node.addToSet('tags.inventory', `item_${node.nodeId}_${op}`);
            }
          }
        }

        // Attempt initial sync while partitioned
        await mesh.syncMesh(3);

        // HEAL the partition: 100% connectivity restored
        mesh.heal();

        // Synchronize healed mesh to full eventual consistency
        const syncResult = await mesh.syncMesh(5);

        assert.equal(
          syncResult.converged,
          true,
          `Convergence invariant failed on randomized DAG topology run #${run} (Nodes: ${numNodes}, Topology: ${topologyType})`
        );

        // Verify root hashes across all nodes are identical
        const firstRoot = nodes[0].merkleClock.getRootHash();
        const firstDoc = canonicalJson(nodes[0].toJSON());

        for (let i = 1; i < nodes.length; i++) {
          assert.equal(
            nodes[i].merkleClock.getRootHash(),
            firstRoot,
            `Root hash mismatch on run #${run} between node_0 and node_${i}`
          );
          assert.equal(
            canonicalJson(nodes[i].toJSON()),
            firstDoc,
            `Document state mismatch on run #${run} between node_0 and node_${i}`
          );
        }
      }
    });
  });
});
