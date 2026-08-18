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

function clientBoundCatalog(client) {
  return new Map([['stable-tool', {
    fingerprint: 'stable-fingerprint',
    summary: { name: 'stable-tool', description: 'stable description' },
    definition: {
      name: 'stable-tool',
      execute() { return client.name }
    }
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

test('concurrent activation during cold discovery never republishes retained executors', async () => {
  const adapter = createAdapter()
  const nextDiscovery = deferred()
  const previousClient = createClient('previous-client')
  const currentClient = createClient('current-client')
  const clients = [previousClient, currentClient]
  const previousAgent = { id: 'previous-agent' }
  let connectionAttempts = 0
  let discoveryAttempts = 0
  let firstActivation
  let secondActivation
  const runtime = createServerRuntime(runtimeOptions({
    adapter,
    config: {
      serverName: 'runtime-fixture',
      autoActivate: false,
      releaseOnTurnEnd: true,
      warmIdleMs: 20
    },
    async createConnectedClient() { return clients[connectionAttempts++] },
    async discoverDefinitions(client) {
      discoveryAttempts += 1
      if (discoveryAttempts === 1) return clientBoundCatalog(client)
      return nextDiscovery.promise
    }
  }))

  try {
    await runtime.activate(previousAgent)
    assert.equal(adapter.definitions.get('stable-tool').execute(), 'previous-client')
    runtime.onTurnStopping({ agent: previousAgent })
    await waitFor(
      () => previousClient.closeCalls === 1 && adapter.definitions.size === 0,
      'warm expiry closes the previous client and unpublishes its schemas'
    )

    firstActivation = runtime.activate({ id: 'first-current-agent' })
    await waitFor(() => discoveryAttempts === 2, 'new cold discovery starts')
    let secondSettled = false
    secondActivation = runtime.activate({ id: 'second-current-agent' }).then((result) => {
      secondSettled = true
      return result
    })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(secondSettled, false, 'concurrent activation must wait for current discovery')
    assert.equal(adapter.definitions.size, 0, 'retained schemas must stay unpublished during cold discovery')

    nextDiscovery.resolve(clientBoundCatalog(currentClient))
    const [firstResult, secondResult] = await Promise.all([firstActivation, secondActivation])
    assert.equal(secondResult, firstResult)
    assert.equal(adapter.definitions.get('stable-tool').execute(), 'current-client')
    assert.equal(connectionAttempts, 2)
  } finally {
    nextDiscovery.resolve(clientBoundCatalog(currentClient))
    await Promise.allSettled([firstActivation, secondActivation].filter(Boolean))
    await runtime.dispose()
  }
})

test('turn stopping clears reconnect demand without releasing persistent schemas', async () => {
  const adapter = createAdapter()
  const clients = []
  const callbacks = []
  let connectionAttempts = 0
  const runtime = createServerRuntime(runtimeOptions({
    adapter,
    async createConnectedClient(_signal, handlers) {
      const client = createClient(`persistent-${connectionAttempts + 1}`)
      clients.push(client)
      callbacks.push(handlers)
      connectionAttempts += 1
      return client
    },
    async discoverDefinitions() { return catalog('persistent-tool') }
  }))

  try {
    const agent = { id: 'persistent-agent' }
    await runtime.activate(agent)
    runtime.onTurnStopping({ agent })
    assert.ok(adapter.definitions.has('persistent-tool'), 'turn stop must not release persistent schemas')

    callbacks[0].onClose(clients[0])
    await new Promise((resolve) => setTimeout(resolve, 250))

    assert.equal(connectionAttempts, 1)
    assert.equal(adapter.definitions.size, 0)
  } finally {
    await runtime.dispose()
  }
})

test('agent disposal releases a persistent connection after turn stopping removed demand', async () => {
  const adapter = createAdapter()
  const client = createClient('persistent-disposed')
  const runtime = createServerRuntime(runtimeOptions({
    adapter,
    async createConnectedClient() { return client },
    async discoverDefinitions() { return catalog('persistent-tool') }
  }))

  try {
    const agent = { id: 'persistent-agent' }
    await runtime.activate(agent)
    runtime.onTurnStopping({ agent })

    assert.ok(adapter.definitions.has('persistent-tool'), 'turn stop preserves persistent schemas')
    assert.equal(client.closeCalls, 0, 'turn stop preserves the persistent client')

    runtime.onAgentDisposed({ agent })
    await waitFor(
      () => adapter.definitions.size === 0 && client.closeCalls === 1,
      'agent disposal releases the persistent client and schemas'
    )
  } finally {
    await runtime.dispose()
  }
})

test('delayed duplicate agent disposal does not extend an active warm-idle deadline', async () => {
  const adapter = createAdapter()
  const client = createClient('warm-disposed')
  const runtime = createServerRuntime(runtimeOptions({
    adapter,
    config: {
      serverName: 'runtime-fixture',
      autoActivate: false,
      releaseOnTurnEnd: true,
      warmIdleMs: 50
    },
    async createConnectedClient() { return client },
    async discoverDefinitions() { return catalog('warm-tool') }
  }))

  try {
    const agent = { id: 'warm-agent' }
    await runtime.activate(agent)
    runtime.onTurnStopping({ agent })

    await new Promise((resolve) => setTimeout(resolve, 35))
    runtime.onAgentDisposed({ agent })
    setTimeout(() => runtime.onAgentDisposed({ agent }), 10)
    setTimeout(() => runtime.onAgentDisposed({ agent }), 20)

    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(client.closeCalls, 1, 'warm client closes from the turn-stop deadline')
    assert.equal(adapter.definitions.size, 0)

    runtime.onAgentDisposed({ agent })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(client.closeCalls, 1, 'repeated disposal stays idempotent after close')
  } finally {
    await runtime.dispose()
  }
})

test('irrelevant agent disposal preserves a persistent connection used by another agent', async () => {
  const adapter = createAdapter()
  const client = createClient('persistent-shared')
  const runtime = createServerRuntime(runtimeOptions({
    adapter,
    async createConnectedClient() { return client },
    async discoverDefinitions() { return catalog('shared-tool') }
  }))
  const disposedAgent = { id: 'disposed-agent' }
  const activeAgent = { id: 'active-agent' }

  try {
    await runtime.activate(disposedAgent)
    await runtime.activate(activeAgent)
    runtime.onAgentDisposed({ agent: disposedAgent })
    runtime.onAgentDisposed({ agent: disposedAgent })
    runtime.onAgentDisposed({ agent: { id: 'irrelevant-agent' } })

    assert.ok(adapter.definitions.has('shared-tool'))
    assert.equal(client.closeCalls, 0)
  } finally {
    await runtime.dispose()
  }
})

test('agent disposal preserves an auto-activated connection without users', async () => {
  const adapter = createAdapter()
  const client = createClient('persistent-auto')
  const runtime = createServerRuntime(runtimeOptions({
    adapter,
    config: {
      serverName: 'runtime-fixture',
      autoActivate: true,
      releaseOnTurnEnd: false,
      warmIdleMs: 0
    },
    async createConnectedClient() { return client },
    async discoverDefinitions() { return catalog('auto-tool') }
  }))

  try {
    await runtime.activate()
    runtime.onAgentDisposed({ agent: { id: 'irrelevant-agent' } })

    assert.ok(adapter.definitions.has('auto-tool'))
    assert.equal(client.closeCalls, 0)
  } finally {
    await runtime.dispose()
  }
})
