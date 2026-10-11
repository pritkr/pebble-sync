import { PebbleSyncNode } from '../sync/orchestrator.js';
import { NodeId, SyncMessage } from '../types.js';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'syncing'
  | 'reconnecting'
  | 'closed';

export type WebSocketSyncFrame =
  | { type: 'ping'; timestamp: number; nodeId: NodeId }
  | { type: 'pong'; timestamp: number; nodeId: NodeId }
  | { type: 'sync'; message: SyncMessage };

export interface WebSocketLike {
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (...args: any[]) => void): void;
  removeEventListener?(type: string, listener: (...args: any[]) => void): void;
  onopen?: ((ev: any) => any) | null;
  onclose?: ((ev: any) => any) | null;
  onmessage?: ((ev: any) => any) | null;
  onerror?: ((ev: any) => any) | null;
}

export interface WebSocketSyncClientOptions {
  url: string;
  node: PebbleSyncNode;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  backoffMultiplier?: number;
  maxRetries?: number;
  autoReconnect?: boolean;
  onStateChange?: (state: ConnectionState) => void;
  onSyncComplete?: (converged: boolean) => void;
  onError?: (err: Error) => void;
  customWebSocketFactory?: (url: string) => WebSocketLike;
}

/**
 * WebSocketSyncClient
 * Connects to a remote Pebble-Sync WebSocket server, orchestrates the 3-step
 * Merkle exchange (Offer -> Request -> Response), monitors liveness via ping/pong
 * heartbeats, and automatically reconnects using exponential backoff.
 */
export class WebSocketSyncClient {
  readonly node: PebbleSyncNode;
  readonly url: string;

  private state: ConnectionState = 'disconnected';
  private ws: WebSocketLike | null = null;
  private retryAttempt = 0;
  private reconnectTimer: any = null;
  private heartbeatIntervalTimer: any = null;
  private heartbeatTimeoutTimer: any = null;
  private lastPongReceived = 0;
  private explicitClose = false;

  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxRetries: number;
  private readonly autoReconnect: boolean;
  private readonly onStateChange?: (state: ConnectionState) => void;
  private readonly onSyncComplete?: (converged: boolean) => void;
  private readonly onError?: (err: Error) => void;
  private readonly customWebSocketFactory?: (url: string) => WebSocketLike;

  constructor(options: WebSocketSyncClientOptions) {
    this.node = options.node;
    this.url = options.url;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 3000;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 200;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5000;
    this.backoffMultiplier = options.backoffMultiplier ?? 1.5;
    this.maxRetries = options.maxRetries ?? Infinity;
    this.autoReconnect = options.autoReconnect ?? true;
    this.onStateChange = options.onStateChange;
    this.onSyncComplete = options.onSyncComplete;
    this.onError = options.onError;
    this.customWebSocketFactory = options.customWebSocketFactory;
  }

  getState(): ConnectionState {
    return this.state;
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(newState);
    }
  }

  /**
   * Connect to the WebSocket sync server.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.explicitClose = false;
    this.setState(this.retryAttempt > 0 ? 'reconnecting' : 'connecting');

    return new Promise<void>((resolve, reject) => {
      let isResolved = false;

      try {
        const createWs =
          this.customWebSocketFactory ??
          ((u: string) => {
            if (typeof WebSocket !== 'undefined') {
              return new WebSocket(u);
            }
            throw new Error('No global WebSocket available. Provide customWebSocketFactory.');
          });

        this.ws = createWs(this.url);
      } catch (err: any) {
        this.setState('disconnected');
        this.handleFailure(err);
        return reject(err);
      }

      this.ws.onopen = () => {
        isResolved = true;
        this.retryAttempt = 0;
        this.setState('connected');
        this.startHeartbeat();
        // Immediately initiate Step 1 of Merkle exchange: send SyncOffer
        this.triggerSync();
        resolve();
      };

      this.ws.onmessage = async (event: any) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString();
          const frame: WebSocketSyncFrame = JSON.parse(raw);
          await this.handleFrame(frame);
        } catch (err: any) {
          this.onError?.(err);
        }
      };

      this.ws.onerror = (event: any) => {
        const error = event?.error || new Error('WebSocket error occurred');
        this.onError?.(error);
        if (!isResolved) {
          isResolved = true;
          reject(error);
        }
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        this.ws = null;
        if (!this.explicitClose) {
          this.handleFailure(new Error('WebSocket connection closed'));
        } else {
          this.setState('closed');
        }
      };
    });
  }

  /**
   * Trigger bi-directional Merkle 3-step sync exchange by offering current frontier.
   */
  triggerSync(): void {
    if (!this.ws || this.state === 'closed' || this.state === 'disconnected') {
      return;
    }
    this.setState('syncing');
    const offer = this.node.createSyncOffer();
    this.sendFrame({ type: 'sync', message: offer });
  }

  /**
   * Send arbitrary sync message over WebSocket.
   */
  sendSyncMessage(msg: SyncMessage): void {
    this.sendFrame({ type: 'sync', message: msg });
  }

  private sendFrame(frame: WebSocketSyncFrame): void {
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === undefined)) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  /**
   * Handle incoming framed message from server.
   */
  private async handleFrame(frame: WebSocketSyncFrame): Promise<void> {
    if (frame.type === 'ping') {
      // Respond to server heartbeat
      this.sendFrame({ type: 'pong', timestamp: Date.now(), nodeId: this.node.nodeId });
      return;
    }

    if (frame.type === 'pong') {
      // Heartbeat ack from server
      this.lastPongReceived = Date.now();
      if (this.heartbeatTimeoutTimer) {
        clearTimeout(this.heartbeatTimeoutTimer);
        this.heartbeatTimeoutTimer = null;
      }
      return;
    }

    if (frame.type === 'sync') {
      const msg = frame.message;

      if (msg.type === 'sync_offer') {
        // Step 2: Handle server's offer -> Send request if needed
        const req = this.node.handleSyncOffer(msg);
        if (req) {
          this.sendFrame({ type: 'sync', message: req });
        } else {
          // Identical frontiers, no delta needed
          this.setState('connected');
          this.onSyncComplete?.(true);
        }
      } else if (msg.type === 'sync_request') {
        // Step 3: Handle server's request -> Send response with missing nodes & signed deltas
        const resp = this.node.handleSyncRequest(msg);
        this.sendFrame({ type: 'sync', message: resp });
      } else if (msg.type === 'sync_response') {
        // Step 4: Apply incoming deltas and verify convergence
        const result = await this.node.handleSyncResponse(msg);
        this.setState('connected');
        if (result.valid) {
          this.onSyncComplete?.(true);
        } else {
          this.onError?.(new Error(`Sync verification failed: ${result.error}`));
          this.onSyncComplete?.(false);
        }
      }
    }
  }

  /**
   * Start heartbeat ping/pong timer.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongReceived = Date.now();

    this.heartbeatIntervalTimer = setInterval(() => {
      if (!this.ws) return;

      // Send ping
      this.sendFrame({ type: 'ping', timestamp: Date.now(), nodeId: this.node.nodeId });

      // Start timeout waiting for pong
      this.heartbeatTimeoutTimer = setTimeout(() => {
        // Timed out waiting for heartbeat response: terminate and reconnect
        this.onError?.(new Error('Heartbeat ping timed out'));
        this.ws?.close(4000, 'Heartbeat timeout');
      }, this.heartbeatTimeoutMs);
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatIntervalTimer) {
      clearInterval(this.heartbeatIntervalTimer);
      this.heartbeatIntervalTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * Handle unexpected disconnection and trigger exponential backoff.
   */
  private handleFailure(error: Error): void {
    if (this.explicitClose) return;

    if (!this.autoReconnect || this.retryAttempt >= this.maxRetries) {
      this.setState('disconnected');
      return;
    }

    this.setState('reconnecting');
    const delay = Math.min(
      this.maxRetryDelayMs,
      this.initialRetryDelayMs * Math.pow(this.backoffMultiplier, this.retryAttempt)
    );
    this.retryAttempt++;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((e) => {
        this.onError?.(e);
      });
    }, delay);
  }

  /**
   * Disconnect cleanly and stop all reconnect timers.
   */
  disconnect(): void {
    this.explicitClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnected');
      this.ws = null;
    }
    this.setState('closed');
  }
}

export interface WebSocketSyncServerOptions {
  port?: number;
  node: PebbleSyncNode;
  heartbeatIntervalMs?: number;
  onClientConnect?: (clientId: string) => void;
  onClientDisconnect?: (clientId: string) => void;
  onSyncComplete?: (clientId: string, converged: boolean) => void;
}

/**
 * WebSocketSyncServer
 * Listens for incoming peer connections over WebSockets, coordinates the 3-step
 * Merkle sync exchange with all connected peers, and broadcasts sync offers
 * on local mutations.
 */
export class WebSocketSyncServer {
  readonly node: PebbleSyncNode;
  private port: number | null = null;
  private serverInstance: any = null;
  private clients = new Map<string, WebSocketLike>();
  private clientCounter = 0;
  private isRunning = false;

  private readonly heartbeatIntervalMs: number;
  private readonly onClientConnect?: (clientId: string) => void;
  private readonly onClientDisconnect?: (clientId: string) => void;
  private readonly onSyncComplete?: (clientId: string, converged: boolean) => void;

  constructor(options: WebSocketSyncServerOptions) {
    this.node = options.node;
    this.port = options.port ?? 0;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.onClientConnect = options.onClientConnect;
    this.onClientDisconnect = options.onClientDisconnect;
    this.onSyncComplete = options.onSyncComplete;
  }

  getPort(): number | null {
    return this.port;
  }

  getConnectedPeers(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Start native WebSocket server (uses Bun.serve in Bun environment).
   */
  async start(port = this.port ?? 0): Promise<number> {
    if (this.isRunning) return this.port!;

    if (typeof (globalThis as any).Bun !== 'undefined') {
      const Bun = (globalThis as any).Bun;
      const self = this;

      this.serverInstance = Bun.serve({
        port,
        fetch(req: any, server: any) {
          const clientId = `peer-${++self.clientCounter}`;
          if (server.upgrade(req, { data: { clientId } })) {
            return;
          }
          return new Response('WebSocket upgrade required', { status: 426 });
        },
        websocket: {
          open(ws: any) {
            const clientId = ws.data?.clientId || `peer-${++self.clientCounter}`;
            self.clients.set(clientId, ws);
            self.onClientConnect?.(clientId);

            // Automatically send SyncOffer to client on connect
            const offer = self.node.createSyncOffer();
            ws.send(JSON.stringify({ type: 'sync', message: offer }));
          },
          async message(ws: any, raw: string | Uint8Array) {
            const clientId = ws.data?.clientId || 'unknown';
            try {
              const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
              const frame: WebSocketSyncFrame = JSON.parse(text);
              await self.handleFrame(ws, clientId, frame);
            } catch (err: any) {
              console.error('Server message processing error:', err);
            }
          },
          close(ws: any) {
            const clientId = ws.data?.clientId || 'unknown';
            self.clients.delete(clientId);
            self.onClientDisconnect?.(clientId);
          },
        },
      });

      this.port = this.serverInstance.port;
      this.isRunning = true;
      return this.port!;
    }

    throw new Error('Unsupported server runtime: Bun.serve required for native server listening.');
  }

  /**
   * Handle an arbitrary WebSocket connection (supports mock transports and testing).
   */
  handleConnection(ws: WebSocketLike, clientId = `peer-${++this.clientCounter}`): void {
    this.clients.set(clientId, ws);
    this.onClientConnect?.(clientId);

    ws.onmessage = async (event: any) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : event.data.toString();
        const frame: WebSocketSyncFrame = JSON.parse(raw);
        await this.handleFrame(ws, clientId, frame);
      } catch (err: any) {
        console.error('WebSocket connection handle error:', err);
      }
    };

    ws.onclose = () => {
      this.clients.delete(clientId);
      this.onClientDisconnect?.(clientId);
    };

    // Send initial SyncOffer
    const offer = this.node.createSyncOffer();
    ws.send(JSON.stringify({ type: 'sync', message: offer }));
  }

  private async handleFrame(ws: WebSocketLike, clientId: string, frame: WebSocketSyncFrame): Promise<void> {
    if (frame.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now(), nodeId: this.node.nodeId }));
      return;
    }

    if (frame.type === 'pong') {
      return;
    }

    if (frame.type === 'sync') {
      const msg = frame.message;

      if (msg.type === 'sync_offer') {
        const req = this.node.handleSyncOffer(msg);
        if (req) {
          ws.send(JSON.stringify({ type: 'sync', message: req }));
        } else {
          this.onSyncComplete?.(clientId, true);
        }
      } else if (msg.type === 'sync_request') {
        const resp = this.node.handleSyncRequest(msg);
        ws.send(JSON.stringify({ type: 'sync', message: resp }));
      } else if (msg.type === 'sync_response') {
        const result = await this.node.handleSyncResponse(msg);
        if (result.valid) {
          this.onSyncComplete?.(clientId, true);
        } else {
          this.onSyncComplete?.(clientId, false);
        }
      }
    }
  }

  /**
   * Broadcast a sync message to all connected peer clients.
   */
  broadcast(msg: SyncMessage): void {
    const frame: WebSocketSyncFrame = { type: 'sync', message: msg };
    const payload = JSON.stringify(frame);
    for (const ws of this.clients.values()) {
      try {
        ws.send(payload);
      } catch (err) {
        // Ignored if peer disconnected
      }
    }
  }

  /**
   * Broadcast current SyncOffer to all connected peers.
   */
  broadcastSyncOffer(): void {
    this.broadcast(this.node.createSyncOffer());
  }

  /**
   * Stop the server and disconnect all connected clients.
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    for (const ws of this.clients.values()) {
      try {
        ws.close(1000, 'Server stopping');
      } catch {
        // Ignore
      }
    }
    this.clients.clear();

    if (this.serverInstance) {
      this.serverInstance.stop(true);
      this.serverInstance = null;
    }
    this.port = null;
  }
}

/**
 * Creates an in-memory paired mock WebSocket transport for hermetic testing.
 */
export function createMockWebSocketPair(): {
  clientSocket: WebSocketLike;
  serverSocket: WebSocketLike;
} {
  class MockSocket implements WebSocketLike {
    readyState = 0;
    peer: MockSocket | null = null;
    private _onopen: ((ev: any) => any) | null = null;
    onclose: ((ev: any) => any) | null = null;
    onmessage: ((ev: any) => any) | null = null;
    onerror: ((ev: any) => any) | null = null;

    get onopen() {
      return this._onopen;
    }

    set onopen(fn: ((ev: any) => any) | null) {
      this._onopen = fn;
      if (fn && this.readyState === 0) {
        queueMicrotask(() => {
          if (this.readyState === 0) {
            this.readyState = 1;
            this._onopen?.({});
          }
        });
      }
    }

    send(data: string | Uint8Array): void {
      if (this.readyState !== 1) throw new Error('WebSocket is not open');
      queueMicrotask(() => {
        if (this.peer && this.peer.readyState === 1 && this.peer.onmessage) {
          this.peer.onmessage({ data });
        }
      });
    }

    close(code = 1000, reason = ''): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onclose) this.onclose({ code, reason });
      if (this.peer && this.peer.readyState !== 3) {
        this.peer.readyState = 3;
        if (this.peer.onclose) this.peer.onclose({ code, reason });
      }
    }
  }

  const clientSocket = new MockSocket();
  const serverSocket = new MockSocket();
  serverSocket.readyState = 1;
  clientSocket.peer = serverSocket;
  serverSocket.peer = clientSocket;

  return { clientSocket, serverSocket };
}
