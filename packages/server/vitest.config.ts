import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
    // Rotation/replication tests rely on real timers and real gRPC servers.
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportOnFailure: true,
      include: ['src/**/*.ts'],
    },
  },
});
