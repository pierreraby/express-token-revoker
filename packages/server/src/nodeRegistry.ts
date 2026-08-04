import { ValidationError, InternalError } from 'express-token-revoker';

/**
 * Opaque handle the gRPC server uses to deliver ordered events to one node.
 * The server owns the implementation (single-writer queue + keepalives);
 * the registry only tracks it.
 */
export interface NodeConnection {
  /** Enqueue one outbound event for ordered delivery to this node. */
  enqueue(event: unknown): void;
  /** Close the underlying stream (idempotent). */
  close(): void;
}

/**
 * Public view of a registered node (ListNodes).
 */
export interface NodeEntryView {
  nodeId: string;
  /** Highest LSN delivered to this node so far. */
  lastLsn: number;
  /** Epoch milliseconds of the last delivered event / keepalive. */
  lastSeenMs: number;
  /** True while a stream is registered for this node. */
  connected: boolean;
}

interface InternalNodeEntry {
  nodeId: string;
  lastLsn: number;
  lastSeenMs: number;
  connected: boolean;
  connection: NodeConnection;
}

/**
 * Registry of the participant nodes connected to this coordinator, keyed by
 * nodeId. Mirrors core's revokerStore interface shape (init / register /
 * unregister / find / list / destroy / isEmpty) with a distributed payload:
 * per-node replication state instead of revoker instances.
 *
 * Lifecycle is strict like core's store: use before init() or after
 * destroy() throws. One coordinator per process means the registry is owned
 * by the coordinator — it is deliberately a class instance, not a frozen
 * singleton, so tests can run several coordinators side by side.
 */
export class NodeRegistry {
  #nodes: Map<string, InternalNodeEntry> | null = null;

  /**
   * Initializes the registry.
   * @throws {InternalError} If already initialized.
   */
  init(): void {
    if (this.#nodes) {
      throw new InternalError('Node registry is already initialized');
    }
    this.#nodes = new Map();
  }

  #requireMap(): Map<string, InternalNodeEntry> {
    if (!this.#nodes) {
      throw new InternalError('Node registry is not initialized');
    }
    return this.#nodes;
  }

  /**
   * Registers a node with its stream connection.
   *
   * Registering a nodeId that already has an ACTIVE stream is an operator
   * error (duplicate nodeId across processes, or a zombie stream not yet
   * cleaned up) — throws so the service maps it to ALREADY_EXISTS. A stale
   * disconnected entry is replaced, so re-registration after a node restart
   * works naturally once the old stream is cleaned up.
   *
   * @throws {ValidationError} If the nodeId has an active registration.
   */
  registerNode(nodeId: string, connection: NodeConnection): void {
    const nodes = this.#requireMap();
    const existing = nodes.get(nodeId);
    if (existing?.connected) {
      throw new ValidationError(`Node "${nodeId}" is already registered with an active stream`);
    }
    nodes.set(nodeId, {
      nodeId,
      lastLsn: 0,
      lastSeenMs: Date.now(),
      connected: true,
      connection,
    });
  }

  /**
   * Removes a node's registration (stream ended, errored, or coordinator
   * shutdown). Idempotent.
   */
  unregisterNode(nodeId: string): void {
    const nodes = this.#requireMap();
    nodes.delete(nodeId);
  }

  /**
   * Finds a registered node entry, or undefined when unknown.
   */
  findNode(nodeId: string): NodeEntryView | undefined {
    const nodes = this.#requireMap();
    const entry = nodes.get(nodeId);
    if (!entry) {
      return undefined;
    }
    return {
      nodeId: entry.nodeId,
      lastLsn: entry.lastLsn,
      lastSeenMs: entry.lastSeenMs,
      connected: entry.connected,
    };
  }

  /**
   * Internal access to the live connection of a node (server plumbing).
   */
  connectionOf(nodeId: string): NodeConnection | undefined {
    const nodes = this.#requireMap();
    const entry = nodes.get(nodeId);
    return entry?.connected ? entry.connection : undefined;
  }

  /**
   * Lists all registered nodes.
   */
  listNodes(): NodeEntryView[] {
    const nodes = this.#requireMap();
    return Array.from(nodes.values()).map((entry) => ({
      nodeId: entry.nodeId,
      lastLsn: entry.lastLsn,
      lastSeenMs: entry.lastSeenMs,
      connected: entry.connected,
    }));
  }

  /**
   * Records delivery progress for a node (max-merge — events can be
   * re-delivered at-least-once).
   */
  recordSent(nodeId: string, lsn: number): void {
    const nodes = this.#requireMap();
    const entry = nodes.get(nodeId);
    if (!entry) {
      return;
    }
    if (lsn > entry.lastLsn) {
      entry.lastLsn = lsn;
    }
    entry.lastSeenMs = Date.now();
  }

  /**
   * Updates the last-seen timestamp (keepalives).
   */
  touch(nodeId: string): void {
    const nodes = this.#requireMap();
    const entry = nodes.get(nodeId);
    if (entry) {
      entry.lastSeenMs = Date.now();
    }
  }

  /**
   * Closes every active connection, then clears the registry.
   */
  destroy(): void {
    const nodes = this.#requireMap();
    for (const entry of nodes.values()) {
      try {
        entry.connection.close();
      } catch {
        // Closing a half-dead stream must never break shutdown.
      }
    }
    nodes.clear();
    this.#nodes = null;
  }

  /**
   * Whether the registry holds no nodes.
   */
  isEmpty(): boolean {
    return this.#requireMap().size === 0;
  }
}
