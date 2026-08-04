import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateFile } from '../../src/stateFile.js';

/**
 * Unit tests for the atomic sync-state persistence: round-trip, corrupt
 * handling (absent ⇒ rebootstrap), partial-update merge semantics.
 */
describe('StateFile', () => {
  let dir: string;
  let stateFile: StateFile;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etr-statefile-'));
    stateFile = new StateFile(dir, 'node-a');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('read returns null when the file is missing', () => {
    expect(stateFile.read()).toBeNull();
  });

  it('write/read round-trip', () => {
    stateFile.write({ lastLsn: 42, generation: 3, dirty: false });
    expect(stateFile.read()).toEqual({ lastLsn: 42, generation: 3, dirty: false });
  });

  it('a corrupt file is treated as absent (rebootstrap)', () => {
    fs.writeFileSync(stateFile.filePath, '{not-json');
    expect(stateFile.read()).toBeNull();
  });

  it('an invalid shape is treated as absent (rebootstrap)', () => {
    stateFile.write({ lastLsn: 5, generation: 0, dirty: false });
    fs.writeFileSync(stateFile.filePath, JSON.stringify({ lastLsn: -1, generation: 0 }));
    expect(stateFile.read()).toBeNull();
    fs.writeFileSync(stateFile.filePath, JSON.stringify({ lastLsn: 1.5, generation: 0 }));
    expect(stateFile.read()).toBeNull();
    fs.writeFileSync(stateFile.filePath, JSON.stringify({ lastLsn: 1 }));
    expect(stateFile.read()).toBeNull();
  });

  it('update({dirty}) preserves lastLsn/generation (merge semantics)', () => {
    stateFile.write({ lastLsn: 10, generation: 2, dirty: false });
    stateFile.update({ dirty: true });
    expect(stateFile.read()).toEqual({ lastLsn: 10, generation: 2, dirty: true });
  });

  it('update({lastLsn, generation}) preserves the dirty flag', () => {
    stateFile.write({ lastLsn: 10, generation: 2, dirty: true });
    stateFile.update({ lastLsn: 11, generation: 2 });
    expect(stateFile.read()).toEqual({ lastLsn: 11, generation: 2, dirty: true });
  });

  it('update on a missing/corrupt file starts from safe defaults', () => {
    fs.writeFileSync(stateFile.filePath, 'garbage');
    stateFile.update({ dirty: true });
    expect(stateFile.read()).toEqual({ lastLsn: 0, generation: 0, dirty: true });
  });

  it('write leaves no temp file behind', () => {
    stateFile.write({ lastLsn: 1, generation: 0, dirty: false });
    expect(fs.existsSync(`${stateFile.filePath}.tmp`)).toBe(false);
  });

  it('delete removes the file', () => {
    stateFile.write({ lastLsn: 1, generation: 0, dirty: false });
    stateFile.delete();
    expect(stateFile.read()).toBeNull();
  });
});
