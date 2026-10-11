import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PNCounter } from '../src/crdt/pn_counter.js';
import { LWWRegister } from '../src/crdt/lww_register.js';
import { ORSet } from '../src/crdt/or_set.js';
import { DocumentCRDT } from '../src/crdt/document.js';

describe('CRDT Modules', () => {
  describe('PNCounter', () => {
    it('handles local increments and decrements', () => {
      const counter = new PNCounter('nodeA');
      assert.equal(counter.value(), 0);

      counter.increment(5);
      assert.equal(counter.value(), 5);

      counter.decrement(2);
      assert.equal(counter.value(), 3);
    });

    it('merges concurrent increments and decrements across nodes', () => {
      const nodeA = new PNCounter('nodeA');
      const nodeB = new PNCounter('nodeB');

      nodeA.increment(10);
      nodeA.decrement(3); // A = +7

      nodeB.increment(20);
      nodeB.decrement(8); // B = +12

      // Replicate A -> B and B -> A
      nodeA.merge(nodeB);
      nodeB.merge(nodeA);

      assert.equal(nodeA.value(), 19);
      assert.equal(nodeB.value(), 19);
    });

    it('satisfies algebraic semilattice laws: commutativity, associativity, idempotency', () => {
      const a = new PNCounter('nodeA');
      const b = new PNCounter('nodeB');
      const c = new PNCounter('nodeC');

      a.increment(15);
      b.decrement(4);
      c.increment(7);

      const stateA = a.state();
      const stateB = b.state();
      const stateC = c.state();

      // Commutativity: merge(A, B) == merge(B, A)
      const ab = PNCounter.merge(stateA, stateB);
      const ba = PNCounter.merge(stateB, stateA);
      assert.deepEqual(ab, ba);

      // Associativity: merge(merge(A, B), C) == merge(A, merge(B, C))
      const ab_c = PNCounter.merge(ab, stateC);
      const bc = PNCounter.merge(stateB, stateC);
      const a_bc = PNCounter.merge(stateA, bc);
      assert.deepEqual(ab_c, a_bc);

      // Idempotency: merge(A, A) == A
      const aa = PNCounter.merge(stateA, stateA);
      assert.deepEqual(aa, stateA);
    });
  });

  describe('LWWRegister', () => {
    it('sets and updates values', () => {
      const reg = new LWWRegister('nodeA', 'initial');
      assert.equal(reg.get(), 'initial');

      reg.set('updated');
      assert.equal(reg.get(), 'updated');
    });

    it('resolves concurrent writes with later timestamp winning', () => {
      const regA = new LWWRegister('nodeA', 'valA', { wallTime: 1000, counter: 0, nodeId: 'nodeA' });
      const regB = new LWWRegister('nodeB', 'valB', { wallTime: 2000, counter: 0, nodeId: 'nodeB' });

      regA.merge(regB);
      assert.equal(regA.get(), 'valB');
    });

    it('resolves concurrent writes with identical wallTime using logical counter', () => {
      const regA = new LWWRegister('nodeA', 'valA', { wallTime: 1000, counter: 1, nodeId: 'nodeA' });
      const regB = new LWWRegister('nodeB', 'valB', { wallTime: 1000, counter: 2, nodeId: 'nodeB' });

      regA.merge(regB);
      assert.equal(regA.get(), 'valB');
    });

    it('breaks ties deterministically using nodeId when timestamps and counters are identical', () => {
      const regA = new LWWRegister('nodeA', 'valA', { wallTime: 1000, counter: 0, nodeId: 'nodeA' });
      const regB = new LWWRegister('nodeB', 'valB', { wallTime: 1000, counter: 0, nodeId: 'nodeB' });

      // 'nodeB' > 'nodeA' lexicographically
      const mergedAB = LWWRegister.merge(regA.state(), regB.state());
      const mergedBA = LWWRegister.merge(regB.state(), regA.state());

      assert.equal(mergedAB.value, 'valB');
      assert.equal(mergedBA.value, 'valB');
    });
  });

  describe('ORSet', () => {
    it('adds and checks elements', () => {
      const set = new ORSet<string>('nodeA');
      set.add('paracetamol');
      set.add('amoxicillin');

      assert.equal(set.has('paracetamol'), true);
      assert.equal(set.has('amoxicillin'), true);
      assert.equal(set.has('ibuprofen'), false);
      assert.equal(set.size(), 2);
    });

    it('removes elements by tombstoning observed tags', () => {
      const set = new ORSet<string>('nodeA');
      set.add('bandage');
      assert.equal(set.has('bandage'), true);

      set.remove('bandage');
      assert.equal(set.has('bandage'), false);
      assert.equal(set.size(), 0);
    });

    it('guarantees Add-Wins semantics under concurrent add and remove', () => {
      const setA = new ORSet<string>('nodeA');
      setA.add('vaccine-vial');

      // Replicate to node B so both know about tag t0
      const setB = new ORSet<string>('nodeB', setA.state());
      assert.equal(setB.has('vaccine-vial'), true);

      // Now concurrent partition:
      // Node B removes 'vaccine-vial' (tombstones tag t0)
      setB.remove('vaccine-vial');
      assert.equal(setB.has('vaccine-vial'), false);

      // Node A concurrently re-adds 'vaccine-vial' (generates new tag t1)
      setA.add('vaccine-vial');
      assert.equal(setA.has('vaccine-vial'), true);

      // Merge both ways:
      setA.merge(setB);
      setB.merge(setA);

      // The new tag t1 was not observed by node B's remove, so ADD WINS!
      assert.equal(setA.has('vaccine-vial'), true);
      assert.equal(setB.has('vaccine-vial'), true);
    });
  });

  describe('DocumentCRDT', () => {
    it('manages nested document paths with mixed CRDT types', () => {
      const doc = new DocumentCRDT('clinic1');

      // Scalar registers
      doc.set('clinic.name', 'Rampur Rural Health Center');
      doc.set('clinic.district', 'Varanasi');

      // Counters
      doc.increment('stats.patientsTreated', 5);
      doc.increment('stats.patientsTreated', 3);

      // Sets
      doc.addToSet('supplies.essentialMedicines', 'ORS');
      doc.addToSet('supplies.essentialMedicines', 'Zinc');

      const json = doc.toJSON();
      assert.deepEqual(json, {
        clinic: {
          name: 'Rampur Rural Health Center',
          district: 'Varanasi',
        },
        stats: {
          patientsTreated: 8,
        },
        supplies: {
          essentialMedicines: ['ORS', 'Zinc'],
        },
      });
    });

    it('merges concurrent edits across independent document replicas', () => {
      const docA = new DocumentCRDT('nodeA');
      const docB = new DocumentCRDT('nodeB');

      // Initial baseline
      docA.set('patient.id', 'P-101');
      docA.set('patient.status', 'admitted');
      docB.merge(docA);

      // Concurrent edits while offline
      // Node A updates status and adds vital check
      docA.set('patient.status', 'in-treatment');
      docA.increment('patient.vitalsChecked', 1);
      docA.addToSet('patient.symptoms', 'fever');

      // Node B concurrently adds symptoms and increments vitals
      docB.set('patient.doctor', 'Dr. Verma');
      docB.increment('patient.vitalsChecked', 2);
      docB.addToSet('patient.symptoms', 'cough');

      // Reconcile
      docA.merge(docB);
      docB.merge(docA);

      // Both should have converged to the exact same JSON representation
      assert.deepEqual(docA.toJSON(), docB.toJSON());

      const result = docA.toJSON() as any;
      assert.equal(result.patient.id, 'P-101');
      assert.equal(result.patient.doctor, 'Dr. Verma');
      assert.equal(result.patient.vitalsChecked, 3);
      assert.ok(result.patient.symptoms.includes('fever'));
      assert.ok(result.patient.symptoms.includes('cough'));
    });
  });
});
