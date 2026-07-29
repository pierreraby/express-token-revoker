import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Rotation/backup tests rely on real timers and short intervals.
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['dist/**/*.ts'],
      exclude: [
        // Example/demo gRPC client scripts (top-level side effects, not library code)
        'dist/grpc/std-client.ts',
        'dist/grpc/std-client-async.ts',
        // Type-only module (no runtime code)
        'dist/types.ts',
      ],
    },
  },
});
