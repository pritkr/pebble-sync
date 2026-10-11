import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MerkleClock, sha256 } from '../src/merkle/clock.js';
import { DeltaState } from '../src/types.js';

function createDummyDelta(id: string, nodeId: string): DeltaState {
  return {
    deltaId: id,
    nodeId,
    clock: { [nodeId]: 1 },
    timestamp: { wallTime: Date.now(), counter: 0, nodeId },
    patch: { op: 'set_register', path: ['key'], value: id, timestamp: { wallTime: Date.now(), counter: 0, nodeId } },
  };
}

describe('MerkleClock & DAG Engine', () => {
  it('creates causally linked commits with SHA-256 content hashes', () => {
    const clock = new MerkleClock('node1');
    assert.equal(clock.size(), 0);
    assert.deepEqual(clock.getHeads(), []);

    const delta1 = createDummyDelta('delta-1', 'node1');
    const node1 = clock.commit(delta1);

    assert.equal(clock.size(), 1);
    assert.deepEqual(clock.getHeads(), [node1.hash]);
    assert.deepEqual(node1.parents, []);
    assert.equal(node1.height, 1);

    const delta2 = createDummyDelta('delta-2', 'node1');
    const node2 = clock.commit(delta2);

    assert.equal(clock.size(), 2);
    assert.deepEqual(clock.getHeads(), [node2.hash]);
    assert.deepEqual(node2.parents, [node1.hash]);
    assert.equal(node2.height, 2);
  });

  it('computes minimal missing delta sets over low-bandwidth link', () => {
    const clockA = new MerkleClock('nodeA');
    const clockB = new MerkleClock('nodeB');

    // Commit 1 on node A
    const nodeA1 = clockA.commit(createDummyDelta('d1', 'nodeA'));

    // Replicate Commit 1 to node B
    clockB.integrate(nodeA1);
    assert.deepEqual(clockA.getRootHash(), clockB.getRootHash());

    // Node A commits two more mutations locally while offline
    const nodeA2 = clockA.commit(createDummyDelta('d2', 'nodeA'));
    const nodeA3 = clockA.commit(createDummyDelta('d3', 'nodeA'));

    // Node B wants to sync: sends its current heads to Node A
    const remoteHeadsFromB = clockB.getHeads();
    const missingForB = clockA.computeMissingNodes(remoteHeadsFromB);

    // Node A must return ONLY d2 and d3, NOT d1! This saves 2G wire bandwidth.
    assert.equal(missingForB.length, 2);
    assert.equal(missingForB[0].hash, nodeA2.hash);
    assert.equal(missingForB[1].hash, nodeA3.hash);

    // Node B integrates the missing nodes
    for (const m of missingForB) {
      clockB.integrate(m);
    }

    // Now frontiers must match perfectly
    assert.equal(clockA.getRootHash(), clockB.getRootHash());
    assert.deepEqual(clockA.getHeads(), clockB.getHeads());
  });

  it('handles concurrent branches and merges multi-head frontiers', () => {
    const clockA = new MerkleClock('nodeA');
    const clockB = new MerkleClock('nodeB');

    // Common root
    const root = clockA.commit(createDummyDelta('root', 'nodeA'));
    clockB.integrate(root);

    // Offline concurrent edits:
    // Node A creates branch
    const branchA = clockA.commit(createDummyDelta('editA', 'nodeA'));

    // Node B creates concurrent branch
    const branchB = clockB.commit(createDummyDelta('editB', 'nodeB'));

    // Node A computes what Node B needs given Node B's heads and vector clock
    const missingForB = clockA.computeMissingNodes(clockB.getHeads(), clockB.getVectorClock());
    assert.equal(missingForB.length, 1);
    assert.equal(missingForB[0].hash, branchA.hash);

    // Node B computes what Node A needs given Node A's heads and vector clock
    const missingForA = clockB.computeMissingNodes(clockA.getHeads(), clockA.getVectorClock());
    assert.equal(missingForA.length, 1);
    assert.equal(missingForA[0].hash, branchB.hash);

    // Exchange missing nodes
    clockB.integrate(missingForB[0]);
    clockA.integrate(missingForA[0]);

    // Both clocks now have 2 heads (branchA and branchB)
    assert.equal(clockA.getHeads().length, 2);
    assert.equal(clockB.getHeads().length, 2);
    assert.equal(clockA.getRootHash(), clockB.getRootHash());

    // When Node A makes a new commit, it merges both heads into 1 single head
    const mergeCommit = clockA.commit(createDummyDelta('merge-commit', 'nodeA'));
    assert.equal(clockA.getHeads().length, 1);
    assert.equal(mergeCommit.parents.length, 2);
  });

  it('compacts DAG nodes beyond retention horizon while preserving heads', () => {
    const clock = new MerkleClock('node1');
    const hashes: string[] = [];

    for (let i = 0; i < 20; i++) {
      const node = clock.commit(createDummyDelta(`d-${i}`, 'node1'));
      hashes.push(node.hash);
    }

    assert.equal(clock.size(), 20);
    const originalRoot = clock.getRootHash();

    // Compact keeping 5 most recent nodes
    const { prunedCount } = clock.compact(5);
    assert.ok(prunedCount > 0);
    assert.ok(clock.size() <= 10);

    // Frontier heads and root hash remain valid
    assert.equal(clock.getRootHash(), originalRoot);
  });
});
