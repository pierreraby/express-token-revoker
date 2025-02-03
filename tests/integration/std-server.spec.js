import { test } from '@japa/runner'
import { createRevokerClientAsync } from '#dist/grpc/std-client-async.js'
import { createRevoker } from '#dist/index.js' // Assure-toi que Revoker est accessible

const TEST_PORT = 50052 // Choose a different port than the one used in production
const SERVER_ADDRESS = `localhost:${TEST_PORT}`

test.group('gRPC Server Integration Tests', (group) => {
  // let client
  let logger

  group.setup(() => {
    logger = {
      info: (...args) => console.log(...args),
      error: (...args) => console.error(...args),
      warn: (...args) => console.warn(...args),
      debug: (...args) => console.debug(...args)
    }
  })

  test('end-to-end scenario with JWT Revoker', async ({ expect }) => {
    // Crée et enregistre une instance de Revoker
    const jwtRevoker = await createRevoker({
      id: 'JWTrevoker',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.0001,
        rotateTime: 10000,
        backup: true
      },
      grpcEnabled: true,
      grpcPort: TEST_PORT
    })

    const client = createRevokerClientAsync(SERVER_ADDRESS)

    const item = 'item1'

    const listResponse = await client.ListRevokers({})
    expect(listResponse.revokerIds).toContain('JWTrevoker')

    const addResponse = await client.add({ revokerId: 'JWTrevoker', item })
    expect(addResponse.success).toBe(true)

    const hasResponse = await client.has({ revokerId: 'JWTrevoker', item })
    expect(hasResponse.exists).toBe(true)

    const metricsResponse = await client.getMetrics({ revokerId: 'JWTrevoker' })
    expect(metricsResponse.estimatedMetrics).toBeTruthy()
    expect(metricsResponse.configuration).toBeTruthy()

    const resetRestoreResponse = await client.resetAndRestore({ revokerId: 'JWTrevoker' })
    expect(resetRestoreResponse.success).toBe(true)

    const hasResponse2 = await client.has({ revokerId: 'JWTrevoker', item })
    expect(hasResponse2.exists).toBe(true) // Should be true after resetAndRestore
    

    const resetClearDataResponse = await client.resetAndClearData({ revokerId: 'JWTrevoker' })
    expect(resetClearDataResponse.success).toBe(true)

    const hasResponse3 = await client.has({ revokerId: 'JWTrevoker', item })
    expect(hasResponse3.exists).toBe(false) // Should be false after resetAndClearData

    client.close()
    await jwtRevoker.destroy()
  })

  test('end-to-end scenario with Opaque Revoker', async ({ expect }) => {

    const opaqueRevoker= await createRevoker({
      id: 'opaqueRevoker',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.0001,
        rotateTime: 10000,
        backup: true
      },
      grpcEnabled: true,
      grpcPort: TEST_PORT
    })

    const client = createRevokerClientAsync(SERVER_ADDRESS)

    const item = 'item2'

    // Teste les différentes méthodes du service gRPC
    const listResponse = await client.ListRevokers({})
    expect(listResponse.revokerIds).toContain('opaqueRevoker')

    const addResponse = await client.add({ revokerId: 'opaqueRevoker', item })
    expect(addResponse.success).toBe(true)

    const hasResponse1 = await client.has({ revokerId: 'opaqueRevoker', item })
    expect(hasResponse1.exists).toBe(true)

    const metricsResponse = await client.getMetrics({ revokerId: 'opaqueRevoker' })
    expect(metricsResponse.estimatedMetrics).toBeTruthy()
    expect(metricsResponse.configuration).toBeTruthy()

    const resetRestoreResponse = await client.resetAndRestore({ revokerId: 'opaqueRevoker' })
    expect(resetRestoreResponse.success).toBe(true)

    const hasResponse2 = await client.has({ revokerId: 'opaqueRevoker', item })
    expect(hasResponse2.exists).toBe(true) // Devrait être true après resetAndRestore

    const resetClearDataResponse = await client.resetAndClearData({ revokerId: 'opaqueRevoker' })
    expect(resetClearDataResponse.success).toBe(true)

    const hasResponse3 = await client.has({ revokerId: 'opaqueRevoker', item })
    expect(hasResponse3.exists).toBe(false) // Devrait être false après resetAndClearData

    client.close()
    await opaqueRevoker.destroy()
  })

  test('returns error if revoker not found', async ({ expect }) => {
    const jwtRevoker = await createRevoker({
      id: 'JWTrevoker',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.0001,
        rotateTime: 10000,
        backup: true
      },
      grpcEnabled: true,
      grpcPort: TEST_PORT
    })

    const client = createRevokerClientAsync(SERVER_ADDRESS)

    await expect(client.add({ revokerId: 'unknownRevoker', item: 'item1' }))
      .rejects.toThrow('Revoker instance or Bloom filter not found')

    client.close()
    jwtRevoker.destroy()
  })
})