import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
    // Rotation/backup tests rely on real timers and short intervals.
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportOnFailure: true,
      include: ['dist/**/*.ts'],
      exclude: [
        'dist/grpc/std-client.ts',
        'dist/grpc/std-client-async.ts',
        'dist/types.ts',
        'dist/mytest.js',
        'dist/Bloom-filter-manager copy.js',
      ],
    },
  },
});
