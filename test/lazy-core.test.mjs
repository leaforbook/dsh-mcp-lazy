import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRefreshCoordinator,
  discoverTools,
  fingerprintTool,
  reconcileRegistrations
} from '../lib/lazy-core.js'

function tool(name, description = name) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} }
  }
}

function createRegistry() {
  const definitions = new Map()
  let registrations = 0
  let failure
  return {
    definitions,
    get registrations() { return registrations },
    failWhen(predicate) { failure = predicate },
    register(definition) {
      if (definitions.has(definition.name)) throw new Error(`duplicate registration: ${definition.name}`)
      if (failure?.(definition)) throw new Error(`rejected registration: ${definition.name}`)
      registrations += 1
      definitions.set(definition.name, definition)
      let active = true
      return () => {
        if (!active) return
        active = false
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    }
  }
}

test('discoverTools follows every cursor and bounds each request', async () => {
  const requests = []
  const signal = new AbortController().signal
  const pages = new Map([
    [undefined, { tools: [tool('first')], nextCursor: 'two' }],
    ['two', { tools: [tool('second')] }]
  ])

  const result = await discoverTools({
    request: async (message, _schema, options) => {
      requests.push({ message, options })
      return pages.get(message.params?.cursor)
    },
    resultSchema: {},
    timeoutMs: 4321,
    maxPages: 100,
    signal
  })

  assert.deepEqual(result.map((entry) => entry.name), ['first', 'second'])
  assert.deepEqual(requests, [
    { message: { method: 'tools/list' }, options: { timeout: 4321, signal } },
    { message: { method: 'tools/list', params: { cursor: 'two' } }, options: { timeout: 4321, signal } }
  ])
})

test('discoverTools rejects duplicate names across pages', async () => {
  let page = 0
  await assert.rejects(discoverTools({
    request: async () => (++page === 1
      ? { tools: [tool('same')], nextCursor: 'two' }
      : { tools: [tool('same')] }),
    resultSchema: {},
    timeoutMs: 1000,
    maxPages: 100
  }), /listed tool "same" more than once/i)
})

test('discoverTools rejects repeated cursors instead of looping forever', async () => {
  await assert.rejects(discoverTools({
    request: async () => ({ tools: [], nextCursor: 'same' }),
    resultSchema: {},
    timeoutMs: 1000,
    maxPages: 100
  }), /repeated tools\/list cursor.*same/i)
})

test('discoverTools rejects a page beyond the configured maximum', async () => {
  let page = 0
  await assert.rejects(discoverTools({
    request: async () => ({ tools: [tool(`page-${++page}`)], nextCursor: String(page + 1) }),
    resultSchema: {},
    timeoutMs: 1000,
    maxPages: 2
  }), /exceeded 2 tools\/list pages/i)
  assert.equal(page, 2)
})

test('fingerprintTool is stable across object key order and changes with definitions', () => {
  const first = tool('echo', 'old')
  first.inputSchema = {
    type: 'object',
    properties: { alpha: { type: 'string' }, beta: { type: 'number' } }
  }
  const reordered = tool('echo', 'old')
  reordered.inputSchema = {
    properties: { beta: { type: 'number' }, alpha: { type: 'string' } },
    type: 'object'
  }

  assert.equal(fingerprintTool(first), fingerprintTool(reordered))
  assert.notEqual(fingerprintTool(first), fingerprintTool({ ...reordered, description: 'new' }))
})

test('reconcileRegistrations keeps unchanged tools registered without churn', () => {
  const registry = createRegistry()
  const definition = { name: 'echo', description: 'Echo', execute() {} }
  let state = reconcileRegistrations(new Map(), new Map([
    ['echo', { definition, fingerprint: 'v1' }]
  ]), registry.register)

  state = reconcileRegistrations(state, new Map([
    ['echo', { definition: { ...definition }, fingerprint: 'v1' }]
  ]), registry.register)

  assert.equal(registry.registrations, 1)
  assert.equal(registry.definitions.get('echo'), definition)
  state.get('echo').dispose()
  assert.equal(registry.definitions.size, 0)
})

test('reconcileRegistrations applies additions, changes, and removals as one catalog update', () => {
  const registry = createRegistry()
  let state = reconcileRegistrations(new Map(), new Map([
    ['keep', { definition: { name: 'keep', description: 'old' }, fingerprint: 'keep-v1' }],
    ['remove', { definition: { name: 'remove' }, fingerprint: 'remove-v1' }]
  ]), registry.register)

  state = reconcileRegistrations(state, new Map([
    ['keep', { definition: { name: 'keep', description: 'new' }, fingerprint: 'keep-v2' }],
    ['added', { definition: { name: 'added' }, fingerprint: 'added-v1' }]
  ]), registry.register)

  assert.deepEqual([...registry.definitions.keys()].sort(), ['added', 'keep'])
  assert.equal(registry.definitions.get('keep').description, 'new')
  assert.deepEqual([...state.keys()].sort(), ['added', 'keep'])
})

test('reconcileRegistrations rolls back to the last good catalog when registration fails', () => {
  const registry = createRegistry()
  let state = reconcileRegistrations(new Map(), new Map([
    ['stable', { definition: { name: 'stable', description: 'old' }, fingerprint: 'v1' }]
  ]), registry.register)
  registry.failWhen((definition) => definition.description === 'broken')

  assert.throws(() => reconcileRegistrations(state, new Map([
    ['stable', { definition: { name: 'stable', description: 'broken' }, fingerprint: 'v2' }]
  ]), registry.register), /rejected registration: stable/)

  assert.equal(registry.definitions.get('stable').description, 'old')
  state.get('stable').dispose()
  assert.equal(registry.definitions.size, 0)
})

test('createRefreshCoordinator coalesces same-tick requests into one refresh', async () => {
  let refreshes = 0
  const coordinator = createRefreshCoordinator(async () => { refreshes += 1 })

  await Promise.all([coordinator.request(), coordinator.request(), coordinator.request()])

  assert.equal(refreshes, 1)
})

test('createRefreshCoordinator covers a request that arrives during an in-flight refresh', async () => {
  let refreshes = 0
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const coordinator = createRefreshCoordinator(async () => {
    refreshes += 1
    if (refreshes === 1) await firstGate
  })

  const first = coordinator.request()
  while (refreshes === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  const second = coordinator.request()
  releaseFirst()
  await Promise.all([first, second])

  assert.equal(refreshes, 2)
})

test('createRefreshCoordinator permits a later retry after a failed refresh', async () => {
  let refreshes = 0
  const coordinator = createRefreshCoordinator(async () => {
    refreshes += 1
    if (refreshes === 1) throw new Error('temporary failure')
  })

  await assert.rejects(coordinator.request(), /temporary failure/)
  await coordinator.request()

  assert.equal(refreshes, 2)
})

test('createRefreshCoordinator retries a notification that arrives during a failed refresh', async () => {
  let refreshes = 0
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const coordinator = createRefreshCoordinator(async () => {
    refreshes += 1
    if (refreshes === 1) {
      await firstGate
      throw new Error('first refresh failed')
    }
  })

  const first = coordinator.request()
  while (refreshes === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  const second = coordinator.request()
  releaseFirst()

  await assert.rejects(first, /first refresh failed/)
  await second
  assert.equal(refreshes, 2)
})
