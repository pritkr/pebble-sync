import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PebbleSyncNode } from '../src/sync/orchestrator.js';
import { NetworkMesh } from '../src/network/mesh.js';

describe('5-Node Cluster Partition & Eventual Consistency Convergence', () => {
  it('converges 5 nodes under severe network split-brain after partition healing', async () => {
    // 1. Initialize 5 distributed edge nodes
    const nodeNames = [
      'clinic_central',
      'asha_worker_north',
      'asha_worker_south',
      'mobile_van',
      'sub_center',
    ];

    const mesh = new NetworkMesh();
    const nodes = new Map<string, PebbleSyncNode>();

    for (const name of nodeNames) {
      const node = new PebbleSyncNode({ nodeId: name });
      nodes.set(name, node);
      mesh.register(node);
    }

    const central = nodes.get('clinic_central')!;
    const north = nodes.get('asha_worker_north')!;
    const south = nodes.get('asha_worker_south')!;
    const mobile = nodes.get('mobile_van')!;
    const subCenter = nodes.get('sub_center')!;

    // 2. Initial baseline state synced across entire network
    await central.set('district.name', 'Varanasi Rural Health District');
    await central.set('district.code', 'UP-VRN-04');
    await central.increment('inventory.paracetamol', 1000);
    await central.addToSet('protocols.active', 'MaternalCare');

    // Sync all nodes initially
    await mesh.syncMesh(3);
    assert.equal(mesh.verifyConvergence(), true);

    // 3. Inject split-brain network partition:
    // Group A: [clinic_central, sub_center]
    // Group B: [asha_worker_north, asha_worker_south, mobile_van]
    const groupA = ['clinic_central', 'sub_center'];
    const groupB = ['asha_worker_north', 'asha_worker_south', 'mobile_van'];
    mesh.partition(groupA, groupB);

    // Verify communication across partition is severed
    assert.equal(mesh.canCommunicate('clinic_central', 'asha_worker_north'), false);
    assert.equal(mesh.canCommunicate('mobile_van', 'sub_center'), false);
    assert.equal(mesh.canCommunicate('clinic_central', 'sub_center'), true);
    assert.equal(mesh.canCommunicate('asha_worker_north', 'mobile_van'), true);

    // 4. Concurrent independent offline mutations during network partition

    // Group A edits:
    // Clinic central assigns doctor and admits emergency patients
    await central.set('clinic.leadDoctor', 'Dr. Ramesh Chandra');
    await central.increment('stats.emergencyAdmissions', 3);
    await central.decrement('inventory.paracetamol', 50);
    await central.addToSet('protocols.active', 'DengueProtocol');

    // Sub-center receives cold storage vaccine batch
    await subCenter.increment('inventory.covidVaccines', 200);
    await subCenter.increment('stats.outpatientVisits', 15);
    await subCenter.set('coldChain.status', 'operational');

    // Group B edits:
    // ASHA worker North logs door-to-door vaccinations
    await north.increment('stats.outpatientVisits', 22);
    await north.decrement('inventory.paracetamol', 30);
    await north.addToSet('registry.patients', 'P-1001-Amina');
    await north.addToSet('registry.patients', 'P-1002-Suresh');

    // ASHA worker South logs prenatal care
    await south.increment('stats.prenatalVisits', 12);
    await south.increment('stats.outpatientVisits', 8);
    await south.addToSet('registry.patients', 'P-1003-Pooja');
    await south.addToSet('protocols.active', 'NeonatalCare');

    // Mobile clinic van logs rural camps and dispenses medicine
    await mobile.set('mobileUnit.lastLocation', 'Block 7 Remote Hamlet');
    await mobile.decrement('inventory.paracetamol', 45);
    await mobile.increment('stats.emergencyAdmissions', 2);
    await mobile.addToSet('registry.patients', 'P-1004-Karan');

    // 5. Intra-partition gossip synchronization
    // Group A nodes sync among themselves; Group B nodes sync among themselves
    await mesh.syncMesh(3);

    // Group A internal convergence
    assert.equal(mesh.verifyConvergence(groupA), true);
    // Group B internal convergence
    assert.equal(mesh.verifyConvergence(groupB), true);

    // Verify divergence between Group A and Group B during partition
    assert.notEqual(
      JSON.stringify(central.toJSON()),
      JSON.stringify(north.toJSON())
    );
    assert.notEqual(
      central.merkleClock.getRootHash(),
      north.merkleClock.getRootHash()
    );

    // 6. HEAL THE PARTITION: Full connectivity restored
    mesh.heal();
    assert.equal(mesh.canCommunicate('clinic_central', 'asha_worker_north'), true);

    // 7. Full mesh gossip synchronization
    const syncOutcome = await mesh.syncMesh(5);
    assert.equal(syncOutcome.converged, true);

    // 8. RIGOROUS CONVERGENCE VERIFICATION:
    // All 5 nodes must have 100% identical state and identical Merkle root hashes
    const rootHashes = nodeNames.map((name) => nodes.get(name)!.merkleClock.getRootHash());
    const firstRoot = rootHashes[0];
    for (const root of rootHashes) {
      assert.equal(root, firstRoot);
    }

    const jsonRepresentations = nodeNames.map((name) =>
      JSON.stringify(nodes.get(name)!.toJSON())
    );
    const firstJson = jsonRepresentations[0];
    for (const json of jsonRepresentations) {
      assert.equal(json, firstJson);
    }

    // 9. Semantic verification of CRDT merge correctness:
    const finalState = central.toJSON() as any;

    // Total paracetamol inventory: 1000 - 50 - 30 - 45 = 875
    assert.equal(finalState.inventory.paracetamol, 875);

    // Total emergency admissions: 3 + 2 = 5
    assert.equal(finalState.stats.emergencyAdmissions, 5);

    // Total outpatient visits: 15 (subCenter) + 22 (north) + 8 (south) = 45
    assert.equal(finalState.stats.outpatientVisits, 45);

    // Prenatal visits: 12
    assert.equal(finalState.stats.prenatalVisits, 12);

    // Covid vaccines: 200
    assert.equal(finalState.inventory.covidVaccines, 200);

    // Set unions:
    // Protocols active: MaternalCare, DengueProtocol, NeonatalCare
    assert.ok(finalState.protocols.active.includes('MaternalCare'));
    assert.ok(finalState.protocols.active.includes('DengueProtocol'));
    assert.ok(finalState.protocols.active.includes('NeonatalCare'));
    assert.equal(finalState.protocols.active.length, 3);

    // Patient registry: all 4 patients preserved without loss
    assert.ok(finalState.registry.patients.includes('P-1001-Amina'));
    assert.ok(finalState.registry.patients.includes('P-1002-Suresh'));
    assert.ok(finalState.registry.patients.includes('P-1003-Pooja'));
    assert.ok(finalState.registry.patients.includes('P-1004-Karan'));
    assert.equal(finalState.registry.patients.length, 4);

    // Scalar registers
    assert.equal(finalState.clinic.leadDoctor, 'Dr. Ramesh Chandra');
    assert.equal(finalState.coldChain.status, 'operational');
    assert.equal(finalState.mobileUnit.lastLocation, 'Block 7 Remote Hamlet');
  });
});
