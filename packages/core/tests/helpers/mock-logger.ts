import { vi, type Mock } from 'vitest';
import type { GenericLogger } from '../../src/types.js';

/**
 * A GenericLogger where every method is a Vitest mock, so tests can both pass
 * it to library code (it satisfies GenericLogger) and assert on calls.
 */
export type MockLogger = { [K in keyof GenericLogger]: Mock<GenericLogger[K]> };

export function createMockLogger(): MockLogger {
  return {
    info: vi.fn<GenericLogger['info']>(),
    warn: vi.fn<GenericLogger['warn']>(),
    debug: vi.fn<GenericLogger['debug']>(),
    error: vi.fn<GenericLogger['error']>(),
  };
}
