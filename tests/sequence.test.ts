import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SequenceCRDT } from '../src/crdt/sequence.js';

describe('Collaborative Sequence CRDT (Fugue-lite)', () => {
  it('supports local insertions at beginning, middle, and end', () => {
    const seq = new SequenceCRDT<string>('node1');
    assert.equal(seq.length, 0);
    assert.deepEqual(seq.toArray(), []);

    // Insert at beginning: "C"
    seq.insert(0, 'C');
    assert.equal(seq.toString(), 'C');

    // Prepend: "A" before "C" -> "AC"
    seq.insert(0, 'A');
    assert.equal(seq.toString(), 'AC');

    // Insert in middle: "B" between "A" and "C" -> "ABC"
    seq.insert(1, 'B');
    assert.equal(seq.toString(), 'ABC');

    // Append at end: "D" after "C" -> "ABCD"
    seq.insert(3, 'D');
    assert.equal(seq.toString(), 'ABCD');

    assert.equal(seq.length, 4);
    assert.equal(seq.get(0), 'A');
    assert.equal(seq.get(1), 'B');
    assert.equal(seq.get(2), 'C');
    assert.equal(seq.get(3), 'D');
  });

  it('supports multi-character text insertion for clinical notes', () => {
    const seq = new SequenceCRDT<string>('doctorA');
    seq.insertText(0, 'Patient BP: 120/80 mmHg.');
    assert.equal(seq.toString(), 'Patient BP: 120/80 mmHg.');

    // Insert doctor observation in middle
    // "Patient BP: 120/80 mmHg."
    // Find index of "BP"
    const bpIndex = 'Patient '.length;
    seq.insertText(bpIndex, 'Resting ');
    assert.equal(seq.toString(), 'Patient Resting BP: 120/80 mmHg.');
  });

  it('handles deletions and range deletions with tombstoning', () => {
    const seq = new SequenceCRDT<string>('node1');
    seq.insertText(0, 'Hello cruel world');

    // Delete " cruel" (6 characters starting at index 5)
    seq.deleteRange(5, 6);
    assert.equal(seq.toString(), 'Hello world');
    assert.equal(seq.length, 11);

    // Underlying items array retains tombstones for stability
    const allItems = seq.getItems();
    assert.equal(allItems.length, 17);
    const deletedCount = allItems.filter((i) => i.deleted).length;
    assert.equal(deletedCount, 6);
  });

  it('breaks ties deterministically on concurrent single-character insertions at same position', () => {
    const seqA = new SequenceCRDT<string>('nodeA');
    const seqB = new SequenceCRDT<string>('nodeB');

    // Common prefix
    seqA.insertText(0, 'Patient ');
    seqB.merge(seqA);

    // Concurrent insertions at the exact same index 8:
    // nodeA inserts "X"
    seqA.insert(8, 'X');
    // nodeB inserts "Y"
    seqB.insert(8, 'Y');

    // Cross-merge
    seqA.merge(seqB);
    seqB.merge(seqA);

    // Both must converge to the exact same deterministic string
    assert.equal(seqA.toString(), seqB.toString());
    assert.ok(seqA.toString() === 'Patient XY' || seqA.toString() === 'Patient YX');
  });

  it('guarantees non-interleaving under concurrent multi-character typing runs', () => {
    // Classic collaborative editing benchmark:
    // Peer 1 types "CLINICAL "
    // Peer 2 concurrently types "EMERGENCY "
    // Neither run should have its letters interleaved (e.g. C E L M I E N R I G C E A N L C Y)
    const peer1 = new SequenceCRDT<string>('peer1');
    const peer2 = new SequenceCRDT<string>('peer2');

    // Both start empty
    peer1.insertText(0, 'CLINICAL');
    peer2.insertText(0, 'EMERGENCY');

    // Merge peer2 into peer1, and peer1 into peer2
    peer1.merge(peer2);
    peer2.merge(peer1);

    // Verify perfect convergence
    assert.equal(peer1.toString(), peer2.toString());

    const result = peer1.toString();
    // Non-interleaving invariant: one contiguous block must precede the other
    const isValidNonInterleaved =
      result === 'CLINICALEMERGENCY' || result === 'EMERGENCYCLINICAL';

    assert.ok(
      isValidNonInterleaved,
      `Detected interleaving anomaly: expected CLINICALEMERGENCY or EMERGENCYCLINICAL, got: ${result}`
    );
  });

  it('converges across 3 concurrent offline clinical workers editing a patient record', () => {
    const worker1 = new SequenceCRDT<string>('doc_cardiologist');
    const worker2 = new SequenceCRDT<string>('doc_neurologist');
    const worker3 = new SequenceCRDT<string>('nurse_triage');

    // Base admission note
    worker1.insertText(0, 'Admission: Patient John Doe.\n');
    worker2.merge(worker1);
    worker3.merge(worker1);

    // Concurrently while offline:
    // Worker 1 adds cardiac notes
    worker1.insertText(worker1.length, 'Cardio: Normal sinus rhythm.\n');

    // Worker 2 adds neuro notes
    worker2.insertText(worker2.length, 'Neuro: Alert and oriented x4.\n');

    // Worker 3 adds vitals at the beginning
    worker3.insertText(0, 'Vitals: HR 72, Temp 36.8C.\n');

    // 3-way gossip synchronization
    worker1.merge(worker2);
    worker1.merge(worker3);

    worker2.merge(worker1);
    worker3.merge(worker1);

    // Assert 100% convergence across all three replicas
    assert.equal(worker1.toString(), worker2.toString());
    assert.equal(worker2.toString(), worker3.toString());

    // Verify all contents are present
    const finalText = worker1.toString();
    assert.ok(finalText.includes('Vitals: HR 72, Temp 36.8C.'));
    assert.ok(finalText.includes('Admission: Patient John Doe.'));
    assert.ok(finalText.includes('Cardio: Normal sinus rhythm.'));
    assert.ok(finalText.includes('Neuro: Alert and oriented x4.'));
  });

  it('satisfies semilattice algebraic laws: commutativity, associativity, idempotency', () => {
    const a = new SequenceCRDT<string>('nodeA');
    const b = new SequenceCRDT<string>('nodeB');
    const c = new SequenceCRDT<string>('nodeC');

    a.insertText(0, 'Alpha ');
    b.insertText(0, 'Beta ');
    c.insertText(0, 'Gamma ');

    const stateA = a.state();
    const stateB = b.state();
    const stateC = c.state();

    // 1. Commutativity: merge(A, B) == merge(B, A)
    const mergeAB = SequenceCRDT.merge(stateA, stateB);
    const mergeBA = SequenceCRDT.merge(stateB, stateA);
    assert.deepEqual(
      mergeAB.items.map((i) => i.id),
      mergeBA.items.map((i) => i.id)
    );

    // 2. Associativity: merge(merge(A, B), C) == merge(A, merge(B, C))
    const mergeAB_C = SequenceCRDT.merge(mergeAB, stateC);
    const mergeBC = SequenceCRDT.merge(stateB, stateC);
    const mergeA_BC = SequenceCRDT.merge(stateA, mergeBC);
    assert.deepEqual(
      mergeAB_C.items.map((i) => i.id),
      mergeA_BC.items.map((i) => i.id)
    );

    // 3. Idempotency: merge(A, A) == A
    const mergeAA = SequenceCRDT.merge(stateA, stateA);
    assert.deepEqual(
      mergeAA.items.map((i) => i.id),
      stateA.items.map((i) => i.id)
    );
  });
});
