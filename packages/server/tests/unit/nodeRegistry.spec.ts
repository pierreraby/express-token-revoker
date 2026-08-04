import { InternalError, ValidationError } from 'express-token-revoker';
import { beforeEach, describe, expect, it } from 'vitest';
import { type NodeConnection, NodeRegistry } from '../../src/nodeRegistry.js';

/**
 * Fake connection capturing enqueue/close calls.
 */
function fakeConnection(): { enqueued: unknown[]; closeCalls: number } & NodeConnection {
  const conn = {
    enqueued: [] as unknown[],
    closeCalls: 0,
    enqueue(event: unknown) {
      conn.enqueued.push(event);
    },
    close() {
      conn.closeCalls += 1;
    },
  };
  return conn;
}

describe('NodeRegistry — coordinator-side node lifecycle', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
    registry.init();
  });

  describe('lifecycle discipline', () => {
    it('throws before init()', () => {
      const fresh = new NodeRegistry();
      expect(() => fresh.registerNode('n1', fakeConnection())).toThrow(InternalError);
      expect(() => fresh.findNode('n1')).toThrow(InternalError);
      expect(() => fresh.listNodes()).toThrow(InternalError);
      expect(() => fresh.isEmpty()).toThrow(InternalError);
    });

    it('throws when initialized twice', () => {
      expect(() => registry.init()).toThrow(InternalError);
    });

    it('throws after destroy()', () => {
      registry.destroy();
      expect(() => registry.registerNode('n1', fakeConnection())).toThrow(InternalError);
      expect(() => registry.listNodes()).toThrow(InternalError);
    });

    it('destroy() closes every active connection', () => {
      const c1 = fakeConnection();
      const c2 = fakeConnection();
      registry.registerNode('n1', c1);
      registry.registerNode('n2', c2);
      registry.destroy();
      expect(c1.closeCalls).toBe(1);
      expect(c2.closeCalls).toBe(1);
    });

    it('destroy() tolerates connections whose close() throws', () => {
      registry.registerNode('n1', {
        enqueue: () => {},
        close: () => {
          throw new Error('stream already dead');
        },
      });
      expect(() => registry.destroy()).not.toThrow();
    });
  });

  describe('registration', () => {
    it('registers and finds a node', () => {
      registry.registerNode('node-a', fakeConnection());
      const view = registry.findNode('node-a');
      expect(view).toEqual(
        expect.objectContaining({ nodeId: 'node-a', lastLsn: 0, connected: true })
      );
      expect(typeof view?.lastSeenMs).toBe('number');
    });

    it('findNode returns undefined for an unknown node', () => {
      expect(registry.findNode('ghost')).toBeUndefined();
    });

    it('rejects a duplicate registration with an ACTIVE stream', () => {
      registry.registerNode('node-a', fakeConnection());
      expect(() => registry.registerNode('node-a', fakeConnection())).toThrow(ValidationError);
      expect(() => registry.registerNode('node-a', fakeConnection())).toThrow(/already registered/);
    });

    it('allows re-registration after unregister (node restart)', () => {
      registry.registerNode('node-a', fakeConnection());
      registry.unregisterNode('node-a');
      expect(() => registry.registerNode('node-a', fakeConnection())).not.toThrow();
      expect(registry.findNode('node-a')?.connected).toBe(true);
    });

    it('unregister is idempotent', () => {
      registry.registerNode('node-a', fakeConnection());
      registry.unregisterNode('node-a');
      expect(() => registry.unregisterNode('node-a')).not.toThrow();
      expect(registry.findNode('node-a')).toBeUndefined();
    });
  });

  describe('delivery tracking', () => {
    it('recordSent max-merges the LSN (at-least-once redelivery)', () => {
      registry.registerNode('node-a', fakeConnection());
      registry.recordSent('node-a', 5);
      registry.recordSent('node-a', 3);
      expect(registry.findNode('node-a')?.lastLsn).toBe(5);
    });

    it('recordSent on an unknown node is a no-op', () => {
      expect(() => registry.recordSent('ghost', 1)).not.toThrow();
    });

    it('recordSent and touch update lastSeenMs', async () => {
      registry.registerNode('node-a', fakeConnection());
      const before = registry.findNode('node-a')?.lastSeenMs ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 5));
      registry.recordSent('node-a', 1);
      expect(registry.findNode('node-a')?.lastSeenMs).toBeGreaterThanOrEqual(before);
      registry.touch('node-a');
      expect(registry.findNode('node-a')?.lastSeenMs).toBeGreaterThanOrEqual(before);
    });

    it('touch on an unknown node is a no-op', () => {
      expect(() => registry.touch('ghost')).not.toThrow();
    });
  });

  describe('connections and listing', () => {
    it('connectionOf returns the live connection only while connected', () => {
      const conn = fakeConnection();
      registry.registerNode('node-a', conn);
      expect(registry.connectionOf('node-a')).toBe(conn);
      registry.unregisterNode('node-a');
      expect(registry.connectionOf('node-a')).toBeUndefined();
    });

    it('listNodes lists every registered node', () => {
      registry.registerNode('node-a', fakeConnection());
      registry.registerNode('node-b', fakeConnection());
      registry.recordSent('node-b', 9);
      const list = registry.listNodes();
      expect(list).toHaveLength(2);
      expect(list.map((n) => n.nodeId).sort()).toEqual(['node-a', 'node-b']);
      expect(list.find((n) => n.nodeId === 'node-b')?.lastLsn).toBe(9);
    });

    it('isEmpty reflects the registry state', () => {
      expect(registry.isEmpty()).toBe(true);
      registry.registerNode('node-a', fakeConnection());
      expect(registry.isEmpty()).toBe(false);
      registry.unregisterNode('node-a');
      expect(registry.isEmpty()).toBe(true);
    });
  });
});
