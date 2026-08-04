import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InternalError } from 'express-token-revoker';
import { Meta, EMPTY_META_STATE } from '../../src/meta.js';

describe('Meta — atomic coordinator state persistence', () => {
  let dir: string;
  let filePath: string;
  let meta: Meta;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etr-meta-'));
    filePath = path.join(dir, 'coordinator-meta-test.json');
    meta = new Meta(filePath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('read', () => {
    it('returns zeros when the file does not exist yet', () => {
      expect(meta.read()).toEqual({ generation: 0, lastLsn: 0, lastBackupLsn: 0 });
      expect(meta.read()).toEqual({ ...EMPTY_META_STATE });
    });

    it('returns the persisted state after write', () => {
      meta.write({ generation: 3, lastLsn: 42, lastBackupLsn: 40 });
      expect(meta.read()).toEqual({ generation: 3, lastLsn: 42, lastBackupLsn: 40 });
    });

    it('throws InternalError on invalid JSON (no silent reset)', () => {
      fs.writeFileSync(filePath, '{ not json');
      expect(() => meta.read()).toThrow(InternalError);
      expect(() => meta.read()).toThrow(/invalid JSON/);
    });

    it('throws InternalError when the JSON root is not an object', () => {
      fs.writeFileSync(filePath, '42');
      expect(() => meta.read()).toThrow(InternalError);
      expect(() => meta.read()).toThrow(/expected a JSON object/);
    });

    it.each([
      ['missing field', JSON.stringify({ generation: 1, lastLsn: 2 })],
      ['negative value', JSON.stringify({ generation: -1, lastLsn: 2, lastBackupLsn: 0 })],
      ['non-integer value', JSON.stringify({ generation: 1.5, lastLsn: 2, lastBackupLsn: 0 })],
      ['wrong type', JSON.stringify({ generation: '1', lastLsn: 2, lastBackupLsn: 0 })],
    ])('throws InternalError on invalid shape (%s)', (_name, raw) => {
      fs.writeFileSync(filePath, raw);
      expect(() => meta.read()).toThrow(InternalError);
      expect(() => meta.read()).toThrow(/non-negative integers/);
    });

    it('does not leave a temp file after a successful write', () => {
      meta.write({ generation: 1, lastLsn: 1, lastBackupLsn: 0 });
      expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
    });
  });

  describe('write', () => {
    it('creates the parent directory when missing', () => {
      const nested = new Meta(path.join(dir, 'nested', 'deeper', 'meta.json'));
      nested.write({ generation: 0, lastLsn: 1, lastBackupLsn: 0 });
      expect(nested.read()).toEqual({ generation: 0, lastLsn: 1, lastBackupLsn: 0 });
    });

    it('overwrites atomically (repeated writes stay valid)', () => {
      for (let i = 1; i <= 10; i++) {
        meta.write({ generation: i, lastLsn: i * 10, lastBackupLsn: i * 9 });
      }
      expect(meta.read()).toEqual({ generation: 10, lastLsn: 100, lastBackupLsn: 90 });
    });

    it('propagates write failures as InternalError', () => {
      // Make filePath exist as a regular file first, so a meta path inside it
      // cannot be created (mkdir/open must fail).
      meta.write({ generation: 0, lastLsn: 0, lastBackupLsn: 0 });
      const blocked = new Meta(path.join(filePath, 'impossible.json'));
      expect(() => blocked.write({ generation: 0, lastLsn: 0, lastBackupLsn: 0 })).toThrow(
        InternalError
      );
    });
  });

  it('exposes the file path', () => {
    expect(meta.filePath).toBe(filePath);
  });
});
