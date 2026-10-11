import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PebbleSyncNode } from '../src/sync/orchestrator.js';
import { canonicalJson } from '../src/merkle/clock.js';

describe('Wire-Efficiency & Bandwidth Benchmarks (2G Low-Bandwidth)', () => {
  it('achieves >80% bandwidth savings via Merkle delta replication over full-state transfer across 100 operations', async () => {
    const nodeA = new PebbleSyncNode({ nodeId: 'clinic_server' });
    const nodeB = new PebbleSyncNode({ nodeId: 'rural_tablet' });

    // 1. 100 operations creating comprehensive patient health records
    for (let i = 1; i <= 100; i++) {
      await nodeA.set(`patients.P-${i}.name`, `Patient ${i}`);
      await nodeA.set(`patients.P-${i}.details`, {
        age: 20 + (i % 50),
        village: `Hamlet-${(i % 15) + 1}`,
        contact: `+91-9876543${String(i).padStart(3, '0')}`,
        vitals: { bp: '120/80', pulse: 72, spo2: 98 },
        history: ['Malaria_2024', 'Anemia_Mild'],
      });
    }

    // Baseline sync: nodeB is brought up to speed with all 100 operations
    await nodeA.syncWithPeer(nodeB);
    assert.equal(nodeA.merkleClock.getRootHash(), nodeB.merkleClock.getRootHash());

    // 2. Incremental field batch: Node A performs incremental clinical updates
    await nodeA.set('patients.P-101.name', 'Patient 101 (New Admission)');
    await nodeA.set('patients.P-101.details', {
      age: 26,
      village: 'Hamlet-4',
      vitals: { bp: '118/76', pulse: 70, spo2: 99 },
    });
    await nodeA.increment('stats.totalPatientsEnrolled', 1);

    // 3. Measure Full-State Replication payload size:
    // Traditional state-based CvRDTs transmit the entire accumulated state tree
    const fullStatePayload = canonicalJson({
      type: 'full_state_sync',
      docState: nodeA.doc.state(),
      frontier: nodeA.merkleClock.getFrontier(),
    });
    const fullStateBytes = Buffer.byteLength(fullStatePayload, 'utf8');

    // 4. Measure Pebble-Sync Merkle Delta Sync wire bytes:
    const offer = nodeA.createSyncOffer();
    const req = nodeB.handleSyncOffer(offer)!;
    assert.ok(req !== null, 'Node B should detect divergent root hash');

    const resp = nodeA.handleSyncRequest(req);
    const applyResult = await nodeB.handleSyncResponse(resp);
    assert.equal(applyResult.valid, true);

    const offerBytes = Buffer.byteLength(canonicalJson(offer), 'utf8');
    const reqBytes = Buffer.byteLength(canonicalJson(req), 'utf8');
    const respBytes = Buffer.byteLength(canonicalJson(resp), 'utf8');
    const totalMerkleSyncBytes = offerBytes + reqBytes + respBytes;

    // 5. Bandwidth savings calculation
    const bandwidthSavingsPercent =
      ((fullStateBytes - totalMerkleSyncBytes) / fullStateBytes) * 100;

    console.log(`\n  Wire Efficiency Benchmark Results (100 Operations Baseline):`);
    console.log(`  ------------------------------------------------------------`);
    console.log(`  Full State Retransmission Payload : ${fullStateBytes.toLocaleString()} bytes`);
    console.log(`  Merkle Delta Sync Payload (Total)  : ${totalMerkleSyncBytes.toLocaleString()} bytes`);
    console.log(`    - SyncOffer                     : ${offerBytes} bytes`);
    console.log(`    - SyncRequest                   : ${reqBytes} bytes`);
    console.log(`    - SyncResponse (Deltas + DAG)   : ${respBytes} bytes`);
    console.log(`  Bandwidth Reduction Achieved      : ${bandwidthSavingsPercent.toFixed(2)}%\n`);

    // Verify >80% bandwidth reduction (typically >90%)
    assert.ok(
      bandwidthSavingsPercent > 80,
      `Expected >80% bandwidth savings, got ${bandwidthSavingsPercent.toFixed(2)}%`
    );

    // Verify convergence
    assert.equal(nodeA.merkleClock.getRootHash(), nodeB.merkleClock.getRootHash());
    assert.deepEqual(nodeA.toJSON(), nodeB.toJSON());
  });
});
