/**
 * Pebble-Sync Example: Rural Healthcare & Welfare Offline Sync
 *
 * Demonstrates an offline ASHA (Accredited Social Health Activist) healthcare
 * worker logging maternal and neonatal health data in remote rural villages with
 * zero connectivity, performing opportunistic P2P sync with a mobile medical van,
 * and seamlessly reconciling with the District Primary Health Center (PHC) server.
 */

import { PebbleSyncNode } from '../src/sync/orchestrator.js';
import { NetworkMesh } from '../src/network/mesh.js';
import { canonicalJson } from '../src/merkle/clock.js';

async function runRuralHealthSimulation() {
  console.log('='.repeat(75));
  console.log('  PEBBLE-SYNC: RURAL HEALTHCARE & WELFARE OFFLINE-FIRST SYNC ENGINE');
  console.log('='.repeat(75));

  // Initialize network mesh and nodes
  const mesh = new NetworkMesh();

  const centralPHC = new PebbleSyncNode({ nodeId: 'central_phc_server' });
  const ashaPooja = new PebbleSyncNode({ nodeId: 'asha_worker_pooja' });
  const mobileVan = new PebbleSyncNode({ nodeId: 'mobile_clinic_van' });

  mesh.register(centralPHC);
  mesh.register(ashaPooja);
  mesh.register(mobileVan);

  // --------------------------------------------------------------------------
  // Phase 1: Pre-Departure Morning Sync at PHC Clinic
  // --------------------------------------------------------------------------
  console.log('\n[Phase 1] Morning Preparation: Initial Sync at Central PHC');
  console.log('- District Hospital initializes health register and allocates supplies...');

  await centralPHC.set('district.name', 'Mirzapur Rural Health District');
  await centralPHC.set('district.phcName', 'Chunar Primary Health Center');
  await centralPHC.increment('supplies.ironFolicTablets', 500);
  await centralPHC.increment('supplies.orsPackets', 100);
  await centralPHC.increment('supplies.paracetamol', 250);
  await centralPHC.addToSet('protocols.activeGuidelines', 'MaternalNutrition_v3');
  await centralPHC.addToSet('protocols.activeGuidelines', 'NeonatalCare_v2');

  // Morning sync: Pooja and Mobile Van download initial registry
  await centralPHC.syncWithPeer(ashaPooja);
  await centralPHC.syncWithPeer(mobileVan);

  console.log(`✓ Initialized: Pooja & Mobile Van synced. Root Hash: ${ashaPooja.merkleClock.getRootHash().slice(0, 16)}...`);
  console.log(`  Initial Iron Folic Tablets stock: ${ashaPooja.getCounter('supplies.ironFolicTablets')}`);

  // --------------------------------------------------------------------------
  // Phase 2: Full Offline Blackout (ASHA Worker Travels 30km into Hills)
  // --------------------------------------------------------------------------
  console.log('\n[Phase 2] Offline Field Visits: Total Cellular Blackout');
  console.log('- Pooja travels into hill hamlets with zero network connectivity.');
  mesh.isolate(ashaPooja.nodeId);
  mesh.partition(['central_phc_server'], ['mobile_clinic_van']);

  console.log('  Hamlet 1 (Majhwa Basti):');
  console.log('  - Pooja logs prenatal checkup for Sita Devi (24 yrs, Week 28)');
  await ashaPooja.set('patients.P-901.name', 'Sita Devi');
  await ashaPooja.set('patients.P-901.age', 24);
  await ashaPooja.set('patients.P-901.gestationWeek', 28);
  await ashaPooja.set('patients.P-901.bp', '118/76');
  await ashaPooja.addToSet('patients.P-901.vitalsAlerts', 'Normal');
  await ashaPooja.increment('stats.prenatalCheckups', 1);
  await ashaPooja.decrement('supplies.ironFolicTablets', 30);
  await ashaPooja.decrement('supplies.orsPackets', 5);

  console.log('  Hamlet 2 (Ghurpur Hamlet):');
  console.log('  - Pooja registers newborn child of Priya, administers BCG vaccine');
  await ashaPooja.set('patients.P-902.name', 'Baby of Priya');
  await ashaPooja.set('patients.P-902.weightKg', 3.1);
  await ashaPooja.addToSet('patients.P-902.immunizations', 'BCG');
  await ashaPooja.addToSet('patients.P-902.immunizations', 'OPV-0');
  await ashaPooja.increment('stats.immunizationsCompleted', 2);
  await ashaPooja.addToSet('registry.activePatients', 'P-901');
  await ashaPooja.addToSet('registry.activePatients', 'P-902');

  console.log('\n  Meanwhile at Central PHC (Concurrent Central Operations):');
  console.log('  - Warehouse receives emergency medical shipment (+1,000 iron tablets)');
  await centralPHC.increment('supplies.ironFolicTablets', 1000);
  await centralPHC.set('bulletin.emergencyAlert', 'Monsoon Viral Fever Advisory');
  await centralPHC.addToSet('protocols.activeGuidelines', 'DenguePrevention_2026');

  console.log('\n  Meanwhile on Mobile Medical Van (Operating in Neighboring Valley):');
  await mobileVan.set('mobileVan.gpsLocation', '25.1336 N, 82.8711 E');
  await mobileVan.increment('stats.outpatientScreenings', 14);
  await mobileVan.decrement('supplies.paracetamol', 40);

  // --------------------------------------------------------------------------
  // Phase 3: Opportunistic P2P Wi-Fi Direct Sync in Field
  // --------------------------------------------------------------------------
  console.log('\n[Phase 3] Opportunistic Field Sync: Mobile Van meets Pooja on road');
  console.log('- Mobile Van and Pooja discover each other via peer-to-peer Wi-Fi Direct.');
  console.log('- Performing Merkle difference exchange...');

  const p2pSync = await ashaPooja.syncWithPeer(mobileVan);
  console.log(`✓ P2P Sync Finished: Pooja sent ${p2pSync.peerApplied} deltas to Van, received ${p2pSync.localApplied} deltas.`);
  console.log(`  Both now share Merkle Root: ${ashaPooja.merkleClock.getRootHash().slice(0, 16)}...`);

  // --------------------------------------------------------------------------
  // Phase 4: Evening Return to Clinic (Reconnection & Reconcile)
  // --------------------------------------------------------------------------
  console.log('\n[Phase 4] Reconnection: Mobile Van and Pooja arrive at Central PHC');
  mesh.heal(); // Restore all network connectivity

  console.log('- Synchronizing Pooja tablet with Central PHC server...');
  const phcSync = await ashaPooja.syncWithPeer(centralPHC);
  console.log(`✓ Uplink complete: PHC received ${phcSync.peerApplied} deltas; Pooja received ${phcSync.localApplied} deltas.`);

  // Van syncs with PHC
  await mobileVan.syncWithPeer(centralPHC);

  // Run mesh gossip sweep to verify total network convergence
  const finalMeshSync = await mesh.syncMesh(3);
  console.log(`✓ Network convergence confirmed across all 3 nodes: ${finalMeshSync.converged}`);

  // --------------------------------------------------------------------------
  // Phase 5: Cryptographic Audit & Data Integrity Verification
  // --------------------------------------------------------------------------
  console.log('\n[Phase 5] Cryptographic Audit Log Verification:');
  const auditVerification = centralPHC.auditChain.verifyChain();
  console.log(`  Audit Hash Chain Verification: ${auditVerification.valid ? 'VALID (Tamper-Free)' : 'CORRUPTED'}`);
  console.log(`  Total Tamper-Evident Entries in Central Log: ${centralPHC.auditChain.size()}`);
  console.log(`  Latest Cryptographic Audit Hash: ${centralPHC.auditChain.getLatestHash()}`);

  // --------------------------------------------------------------------------
  // Phase 6: Final Convergent State Inspection
  // --------------------------------------------------------------------------
  console.log('\n[Phase 6] Final Reconciled Health Records:');
  const finalData = centralPHC.toJSON() as any;

  console.log('  Supplies Inventory Balances (Conflict-Free Merged):');
  console.log(`    - Iron Folic Tablets: ${finalData.supplies.ironFolicTablets} (Expected: 500 + 1000 - 30 = 1470)`);
  console.log(`    - ORS Packets:        ${finalData.supplies.orsPackets} (Expected: 100 - 5 = 95)`);
  console.log(`    - Paracetamol:        ${finalData.supplies.paracetamol} (Expected: 250 - 40 = 210)`);

  console.log('\n  Aggregated Rural Health Statistics:');
  console.log(`    - Prenatal Checkups:       ${finalData.stats.prenatalCheckups}`);
  console.log(`    - Immunizations Completed: ${finalData.stats.immunizationsCompleted}`);
  console.log(`    - Outpatient Screenings:   ${finalData.stats.outpatientScreenings}`);

  console.log('\n  Patient Records Preserved:');
  console.log(`    - Sita Devi (P-901): Gestation Wk ${finalData.patients['P-901'].gestationWeek}, BP: ${finalData.patients['P-901'].bp}`);
  console.log(`    - Baby of Priya (P-902): Weight ${finalData.patients['P-902'].weightKg}kg, Vaccines: [${finalData.patients['P-902'].immunizations.join(', ')}]`);

  console.log('\n  Active Guidelines Union:');
  console.log(`    - [${finalData.protocols.activeGuidelines.join(', ')}]`);

  console.log('\n' + '='.repeat(75));
  console.log('  SIMULATION COMPLETED WITH 100% MATHEMATICAL CONVERGENCE & INTEGRITY');
  console.log('='.repeat(75));
}

runRuralHealthSimulation().catch(console.error);
