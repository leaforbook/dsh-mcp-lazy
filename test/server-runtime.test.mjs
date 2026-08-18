import assert from 'node:assert/strict'
import test from 'node:test'

import { createServerRuntime } from '../lib/server-runtime.js'

function deferred() {
  let resolve
  const promise = new Promise((settle) => { resolve = settle })
  return { promise, resolve }
}

function catalog(name, fingerprint = name) {
  return new Map([[name, {
    fingerprint,
    summary: { name, description: `${name} description` },
    definition: { name }
  }]])
}

function createAdapter({ failName } = {}) {
  const definitions = new Map()
  return {
    definitions,
    registerTool(definition) {
      if (definition.name === failName) throw new Error(`registration rejected: ${definition.name}`)
      if (definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
    log() {}
  }
}

function createClient(name) {
  return {
    name,
    closeCalls: 0,
    async close() { this.closeCalls += 1 }
  }
}

function runtimeOptions(overrides = {}) {
  return {
    adapter: createAdapter(),
    config: {
      serverName: 'runtime-fixture',
      autoActivate: false,
      releaseOnTurnEnd: false,
      warmIdleMs: 0
    },
    label: 'mcp-lazy(runtime-fixture)',
    reconnectAttempts: 1,
    ...overrides
  }
}

async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out: ${message}`)
}

test('unexpected close during discovery retries while demand remains', async () => {
  const adapter = createAdapter()
  const firstDiscovery = deferred()
  const clients = [createClient('first'), createClient('retry')]
  const callbacks = []
  let connectionAttempts = 0
  let discoveryAttempts = 0
  const runtime = createServerRuntime(runtimeOptions({
    adapter,
    async createConnectedClient(_signal, handlers) {
      callbacks.push(handlers)
      return clients[connectionAttempts++]
    },
    async discoverDefinitions() {
      discoveryAttempts += 1
      if (discoveryAttempts === 1) return firstDiscovery.promise
      return catalog('retry-tool')
    }
  }))

  try {
    const activation = runtime.activate({ id: 'active-user' })
    await waitFor(() => discoveryAttempts === 1, 'first discovery starts')
    callbacks[0].onClose(clients[0])
    firstDiscovery.resolve(catalog('discarded-tool'))
    await activation

    await waitFor(() => adapter.definitions.has('retry-tool'), 'retry publishes the recovered catalog')
    assert.equal(connectionAttempts, 2)
  } finally {
    await runtime.dispose()
  }
})

test('deactivate during discovery closes the connected client once', async () => {
  const discovery = deferred()
  const client = createClient('discovering')
  let discoveryStarted = false
  const runtime = createServerRuntime(runtimeOptions({
    async createConnectedClient() { return client },
    async discoverDefinitions() {
      discoveryStarted = true
      return discovery.promise
    }
  }))

  const activation = runtime.activate({ id: 'active-user' })
  await waitFor(() => discoveryStarted, 'discovery starts')
  const deactivation = runtime.deactivate()
  await waitFor(() => client.closeCalls === 1, 'deactivate owns client close')
  discovery.resolve(catalog('discarded-tool'))
  await Promise.all([activation, deactivation])

  assert.equal(client.closeCalls, 1)
})

test('failed refresh registration preserves the last published catalog', async () => {
  const adapter = createAdapter({ failName: 'new-tool' })
  const client = createClient('refreshing')
  let handlers
  let discoveryAttempts = 0
  const runtime = createServerRuntime(runtimeOptions({
    adapter,
    async createConnectedClient(_signal, callbacks) {
      handlers = callbacks
      return client
    },
    async discoverDefinitions() {
      discoveryAttempts += 1
      return discoveryAttempts === 1 ? catalog('old-tool') : catalog('new-tool')
    }
  }))

  try {
    await runtime.activate({ id: 'active-user' })
    await handlers.onToolsChanged(client)

    assert.deepEqual(runtime.getCatalog(), [
      { name: 'old-tool', description: 'old-tool description' }
    ])
    assert.deepEqual([...adapter.definitions.keys()], ['old-tool'])
  } finally {
    await runtime.dispose()
  }
})
