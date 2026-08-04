import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InternalError } from 'express-token-revoker';
import { CanonicalWal } from '../../src/canonicalWal.js';
import { createMockLogger, type MockLogger } from '../helpers/mock-logger.js';

describe('CanonicalWal — coordinator canonical write-ahead log', () => {
  let dir: string;
  let logger: MockLogger;
  let wal: CanonicalWal;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etr-cwal-'));
    logger = createMockLogger();
    wal = new CanonicalWal({ dir, revokerId: 'test', logger });
    wal.init(1, 0, 0);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const listWalFiles = (): string[] =>
    fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('canonical-test-') && name.endsWith('.wal'))
      .sort();

  describe('append / readSince round-trip', () => {
    it('assigns monotonic LSNs starting at 1', () => {
      expect(wal.appendEntry('one')).toBe(1);
      expect(wal.appendEntry('two')).toBe(2);
      expect(wal.appendEntry('three')).toBe(3);
      expect(wal.lastLsn).toBe(3);
    });

    it('round-trips entries in LSN order', () => {
      wal.appendEntry('one');
      wal.appendEntry('two');
      const events = wal.readSince(0, 100);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'entry', lsn: 1, generation: 0, item: 'one' });
      expect(events[1]).toEqual({ type: 'entry', lsn: 2, generation: 0, item: 'two' });
    });

    it('is safe for items containing colons and tabs (length-prefixed)', () => {
      const tricky = 'jti-a:b\tc:d:12:34';
      const lsn = wal.appendEntry(tricky);
      const events = wal.readSince(lsn - 1, 10);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('entry');
      expect((events[0] as { item?: string }).item).toBe(tricky);
    });

    it('honors the fromLsn cursor', () => {
      wal.appendEntry('one');
      wal.appendEntry('two');
      wal.appendEntry('three');
      const events = wal.readSince(2, 100);
      expect(events).toHaveLength(1);
      expect(events[0].lsn).toBe(3);
    });

    it('caps the result at maxEvents', () => {
      for (let i = 1; i <= 10; i++) {
        wal.appendEntry(`item-${i}`);
      }
      expect(wal.readSince(0, 3)).toHaveLength(3);
      expect(wal.readSince(0, 3).map((e) => e.lsn)).toEqual([1, 2, 3]);
    });

    it('returns an empty array when there is nothing new', () => {
      wal.appendEntry('one');
      expect(wal.readSince(1, 100)).toEqual([]);
    });
  });

  describe('rotation markers', () => {
    it('appendRotate records the marker and switches the generation', () => {
      wal.appendEntry('before');
      const rotateLsn = wal.appendRotate(1);
      expect(rotateLsn).toBe(2);
      expect(wal.generation).toBe(1);

      wal.appendEntry('after');

      expect(listWalFiles()).toEqual(['canonical-test-0.wal', 'canonical-test-1.wal']);
      const events = wal.readSince(0, 100);
      expect(events.map((e) => e.type)).toEqual(['entry', 'rotate', 'entry']);
      expect(events[1]).toEqual({ type: 'rotate', lsn: 2, generation: 1 });
      expect(events[2].generation).toBe(1);
    });

    it('entries inherit the generation of their file/marker context', () => {
      wal.appendRotate(1);
      wal.appendEntry('gen1-item');
      const events = wal.readSince(0, 100);
      const entry = events.find((e) => e.type === 'entry');
      expect(entry?.generation).toBe(1);
    });
  });

  describe('tombstones', () => {
    it('a tombstone overrides its entry in readSince (dedup by LSN)', () => {
      const lsn = wal.appendEntry('failed-apply');
      wal.appendTombstone(lsn, 'failed-apply');
      const events = wal.readSince(lsn - 1, 100);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tombstone');
      expect(events[0].lsn).toBe(lsn);
      expect((events[0] as { item?: string }).item).toBe('failed-apply');
    });

    it('tombstones keep the item so the event stays deliverable', () => {
      wal.appendEntry('x');
      const lsn = wal.appendEntry('y');
      wal.appendTombstone(lsn, 'y');
      wal.appendEntry('z');
      const events = wal.readSince(0, 100);
      expect(events.map((e) => `${e.type}@${e.lsn}`)).toEqual([
        'entry@1',
        'tombstone@2',
        'entry@3',
      ]);
    });
  });

  describe('retention (truncateOldGenerations)', () => {
    it('keeps old-generation files that still hold events above the LSN floor', () => {
      wal.appendEntry('a'); // lsn 1, gen 0
      wal.appendEntry('b'); // lsn 2, gen 0
      wal.appendRotate(1); // lsn 3 marker, switch to gen 1
      wal.appendEntry('c'); // lsn 4, gen 1

      // Floor below the gen-0 file's max LSN: the file must be kept.
      const deleted = wal.truncateOldGenerations(1, 2);
      expect(deleted).toEqual([]);
      expect(listWalFiles()).toEqual(['canonical-test-0.wal', 'canonical-test-1.wal']);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('deletes old-generation files at or below the LSN floor', () => {
      wal.appendEntry('a'); // lsn 1
      wal.appendEntry('b'); // lsn 2
      wal.appendRotate(1); // lsn 3
      wal.appendEntry('c'); // lsn 4

      const deleted = wal.truncateOldGenerations(1, 3);
      expect(deleted).toEqual(['canonical-test-0.wal']);
      expect(listWalFiles()).toEqual(['canonical-test-1.wal']);

      // Only the post-rotation entry survives.
      const events = wal.readSince(0, 100);
      expect(events.map((e) => e.lsn)).toEqual([4]);
    });

    it('never deletes files at or above keepFromGeneration', () => {
      wal.appendEntry('a');
      wal.appendRotate(1);
      wal.appendEntry('b');
      wal.appendRotate(2);
      wal.appendEntry('c');

      // keepFromGeneration=1: only the gen-0 file is below the cut; gen 1
      // and gen 2 are retained regardless of the LSN floor.
      const deleted = wal.truncateOldGenerations(1, 100);
      expect(deleted).toEqual(['canonical-test-0.wal']);
      expect(listWalFiles()).toEqual(['canonical-test-1.wal', 'canonical-test-2.wal']);
    });

    it('deletion raises the servable floor (canServeFrom)', () => {
      wal.appendEntry('a'); // lsn 1
      wal.appendRotate(1); // lsn 2
      wal.appendEntry('b'); // lsn 3

      expect(wal.canServeFrom(0)).toBe(true);
      wal.truncateOldGenerations(1, 2);
      expect(wal.canServeFrom(0)).toBe(false);
      expect(wal.canServeFrom(1)).toBe(false);
      expect(wal.canServeFrom(2)).toBe(true);
      expect(wal.canServeFrom(3)).toBe(true);
    });

    it('respects the retention floor passed at init (deletedMaxLsn from meta)', () => {
      wal = new CanonicalWal({ dir, revokerId: 'other', logger });
      wal.init(10, 0, 7);
      expect(wal.canServeFrom(6)).toBe(false);
      expect(wal.canServeFrom(7)).toBe(true);
    });
  });

  describe('scan (startup discovery)', () => {
    it('finds the highest LSN and generation across files', () => {
      wal.appendEntry('a');
      wal.appendRotate(1);
      wal.appendEntry('b');
      const scan = wal.scan();
      expect(scan.maxLsn).toBe(3);
      expect(scan.maxGeneration).toBe(1);
    });

    it('reports zeros for an empty log', () => {
      expect(wal.scan()).toEqual({ maxLsn: 0, maxGeneration: 0 });
    });
  });

  describe('robustness', () => {
    it('throws when used before init()', () => {
      const fresh = new CanonicalWal({ dir, revokerId: 'fresh', logger });
      expect(() => fresh.appendEntry('x')).toThrow(InternalError);
      expect(() => fresh.readSince(0, 10)).toThrow(InternalError);
      expect(() => fresh.truncateOldGenerations(1, 0)).toThrow(InternalError);
    });

    it('skips malformed lines loudly (torn write) and keeps the rest', () => {
      wal.appendEntry('good');
      fs.appendFileSync(path.join(dir, 'canonical-test-0.wal'), 'garbage line without format\n');
      wal.appendEntry('also-good');

      const events = wal.readSince(0, 100);
      expect(events.map((e) => e.lsn)).toEqual([1, 2]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('malformed'));
    });

    it('creates the directory when it does not exist', () => {
      const nestedDir = path.join(dir, 'nested', 'wal');
      const nested = new CanonicalWal({ dir: nestedDir, revokerId: 'nested', logger });
      nested.init(1, 0, 0);
      expect(fs.existsSync(nestedDir)).toBe(true);
      expect(nested.lastLsn).toBe(0);
    });
  });
});
