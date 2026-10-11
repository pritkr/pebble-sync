import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PebbleSyncNode } from '../src/sync/orchestrator.js';
import {
  WebSocketSyncClient,
  WebSocketSyncServer,
  createMockWebSocketPair,
  ConnectionState,
} from '../src/network/websocket_adapter.js';

describe('Real-Time WebSocket Sync Transport', () => {
  it('executes 3-step Merkle exchange (Offer -> Request -> Response) over mock transport', async () => {
    const nodeA = new PebbleSyncNode({ nodeId: 'nodeA' });
    const nodeB = new PebbleSyncNode({ nodeId: 'nodeB' });

    // Node A commits clinical note locally while offline
    await nodeA.set('clinic.diagnosis', 'Acute Bronchitis');
    await nodeA.set('clinic.triage_level', 2);
    await nodeA.addToSet('clinic.prescriptions', 'Amoxicillin 500mg');

    // Create paired mock WebSockets
    const { clientSocket, serverSocket } = createMockWebSocketPair();

    const server = new WebSocketSyncServer({
      node: nodeB,
    });
    server.handleConnection(serverSocket);

    let syncCompleted = false;

    const client = new WebSocketSyncClient({
      url: 'ws://mock-sync',
      node: nodeA,
      autoReconnect: false,
      customWebSocketFactory: () => clientSocket,
      onSyncComplete: (converged) => {
        if (converged) {
          syncCompleted = true;
        }
      },
    });

    await client.connect();

    // Give microtasks time to exchange Offer -> Request -> Response
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (nodeB.get('clinic.diagnosis') === 'Acute Bronchitis') {
        break;
      }
    }

    // Verify Node B received and applied all mutations from Node A
    assert.equal(nodeB.get('clinic.diagnosis'), 'Acute Bronchitis');
    assert.equal(nodeB.get('clinic.triage_level'), 2);
    assert.deepEqual(nodeB.getSet('clinic.prescriptions'), ['Amoxicillin 500mg']);

    // Cryptographic root hashes must match
    assert.equal(nodeA.merkleClock.getRootHash(), nodeB.merkleClock.getRootHash());

    client.disconnect();
  });

  it('runs live WebSocket sync over native OS network socket with Bun.serve', async () => {
    const serverNode = new PebbleSyncNode({ nodeId: 'server_hospital' });
    const clientNode = new PebbleSyncNode({ nodeId: 'client_ambulance' });

    // Ambulance records patient vitals on the road
    await clientNode.set('patient.heart_rate', 104);
    await clientNode.set('patient.o2_sat', 94);
    await clientNode.addToSet('patient.allergies', 'Penicillin');

    // Hospital server starts on dynamic OS port
    const server = new WebSocketSyncServer({
      node: serverNode,
      port: 0,
    });
    const port = await server.start();
    assert.ok(port > 0);

    const client = new WebSocketSyncClient({
      url: `ws://localhost:${port}`,
      node: clientNode,
      autoReconnect: false,
      heartbeatIntervalMs: 500,
      heartbeatTimeoutMs: 1000,
    });

    await client.connect();

    // Wait for real-time sync convergence
    let converged = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (serverNode.get('patient.heart_rate') === 104) {
        converged = true;
        break;
      }
    }

    assert.equal(converged, true);
    assert.equal(serverNode.get('patient.heart_rate'), 104);
    assert.equal(serverNode.get('patient.o2_sat'), 94);
    assert.deepEqual(serverNode.getSet('patient.allergies'), ['Penicillin']);
    assert.equal(clientNode.merkleClock.getRootHash(), serverNode.merkleClock.getRootHash());

    // Now Hospital updates ER admission bed and broadcasts offer
    await serverNode.set('patient.bed_assigned', 'ER-Bay-3');
    server.broadcastSyncOffer();

    // Ambulance triggers sync
    client.triggerSync();

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (clientNode.get('patient.bed_assigned') === 'ER-Bay-3') {
        break;
      }
    }

    assert.equal(clientNode.get('patient.bed_assigned'), 'ER-Bay-3');
    assert.equal(clientNode.merkleClock.getRootHash(), serverNode.merkleClock.getRootHash());

    client.disconnect();
    await server.stop();
  });

  it('tracks connection state machine transitions', async () => {
    const node = new PebbleSyncNode({ nodeId: 'state_node' });
    const { clientSocket } = createMockWebSocketPair();

    const states: ConnectionState[] = [];

    const client = new WebSocketSyncClient({
      url: 'ws://mock-state',
      node,
      autoReconnect: false,
      customWebSocketFactory: () => clientSocket,
      onStateChange: (s) => states.push(s),
    });

    assert.equal(client.getState(), 'disconnected');

    await client.connect();
    assert.ok(states.includes('connecting'));
    assert.ok(states.includes('connected') || states.includes('syncing'));

    client.disconnect();
    assert.equal(client.getState(), 'closed');
    assert.ok(states.includes('closed'));
  });

  it('handles automatic reconnection with exponential backoff on connection drops', async () => {
    const node = new PebbleSyncNode({ nodeId: 'reconnect_node' });
    let connectCount = 0;
    const states: ConnectionState[] = [];

    const client = new WebSocketSyncClient({
      url: 'ws://mock-reconnect',
      node,
      autoReconnect: true,
      initialRetryDelayMs: 20,
      maxRetryDelayMs: 100,
      backoffMultiplier: 1.5,
      maxRetries: 3,
      customWebSocketFactory: () => {
        connectCount++;
        const { clientSocket } = createMockWebSocketPair();
        return clientSocket;
      },
      onStateChange: (s) => states.push(s),
    });

    await client.connect();
    assert.equal(connectCount, 1);

    // Simulate unexpected server drop (code != 1000 without explicit client close)
    (client as any).ws?.close(1006, 'Abnormal closure');

    // Wait for exponential backoff reconnect attempt
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(connectCount >= 2);
    assert.ok(states.includes('reconnecting'));

    client.disconnect();
  });
});
