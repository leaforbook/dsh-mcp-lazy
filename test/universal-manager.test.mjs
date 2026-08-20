import assert from 'node:assert/strict'
import test from 'node:test'

import { createDshAdapter, createUniversalDshAdapter } from '../lib/dsh-adapter.js'
import { installUniversalManager } from '../lib/universal-manager.js'
import {
  ROUTER_TOOL_NAME,
  registerRouterCompatibleTool,
  registerRouterServer
} from '../lib/tool-router.js'

function eagerTool(name, description = name, execute = async () => ({ content: [] })) {
  return { name, description, parameters: { type: 'object' }, execute }
}

function createHost({
  getToolFactory,
  listenerDisposeThrowsFor,
  restrictionFactory,
  restrictionDisposeFactory
} = {}) {
  const definitions = new Map()
  const schemaOnly = new Map()
  const listeners = new Map()
  const logs = []
  let schemasError
  const counters = {
    routerRegistrations: 0,
    routerDisposals: 0,
    listenerRegistrations: 0,
    listenerDisposals: 0,
    restrictionAttempts: 0,
    restrictionDisposals: 0
  }

  function emit(event, payload) {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload)
  }

  const tools = {
    register(definition) {
      if (definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
      definitions.set(definition.name, definition)
      if (definition.name === ROUTER_TOOL_NAME) counters.routerRegistrations += 1
      emit('tools/change')
      let active = true
      return () => {
        if (!active) return
        active = false
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
        if (definition.name === ROUTER_TOOL_NAME) counters.routerDisposals += 1
        emit('tools/change')
      }
    },
    schemas() {
      if (schemasError !== undefined) throw schemasError
      return [
        ...definitions.values(),
        ...schemaOnly.values()
      ].map(({ name, description, parameters }) => ({ name, description, parameters }))
    },
    get(name) {
      const override = getToolFactory?.({ name, definition: definitions.get(name) })
      if (override instanceof Error) throw override
      if (override !== undefined) return override
      return definitions.get(name)
    }
  }

  const ctx = {
    tools,
    logger: {
      info(message) { logs.push(['info', message]) },
      warn(message) { logs.push(['warn', message]) },
      error(message) { logs.push(['error', message]) }
    },
    on(event, handler) {
      counters.listenerRegistrations += 1
      let bucket = listeners.get(event)
      if (bucket === undefined) listeners.set(event, bucket = new Set())
      bucket.add(handler)
      let active = true
      return () => {
        if (!active) return
        active = false
        counters.listenerDisposals += 1
        bucket.delete(handler)
        if (listenerDisposeThrowsFor === event) throw new Error(`${event} listener dispose failed`)
      }
    },
    effect() { return () => {} }
  }

  function createAgent(id, { restrict = true } = {}) {
    const restrictions = new Set()
    const agent = { id, ctx: { tools: {} }, restrictions }
    if (restrict) {
      agent.ctx.tools.restrict = ({ deny }) => {
        counters.restrictionAttempts += 1
        if (restrictionFactory) {
          const override = restrictionFactory({ agent, deny, attempt: counters.restrictionAttempts })
          if (override instanceof Error) throw override
        }
        const restriction = { deny: new Set(deny), active: true }
        restrictions.add(restriction)
        let active = true
        const defaultDispose = () => {
          if (!active) return
          active = false
          counters.restrictionDisposals += 1
          restriction.active = false
          restrictions.delete(restriction)
        }
        return restrictionDisposeFactory?.({
          agent,
          deny,
          restriction,
          defaultDispose,
          attempt: counters.restrictionAttempts
        }) ?? defaultDispose
      }
    }
    return agent
  }

  function visibleNames(agent) {
    const denied = new Set()
    for (const restriction of agent.restrictions) {
      for (const name of restriction.deny) denied.add(name)
    }
    return [...new Set([...definitions.keys(), ...schemaOnly.keys()])]
      .filter(name => !denied.has(name))
      .sort()
  }

  return {
    ctx,
    counters,
    definitions,
    logs,
    emit,
    createAgent,
    visibleNames,
    register: definition => tools.register(definition),
    addUnresolvedSchema(definition) {
      schemaOnly.set(definition.name, definition)
      emit('tools/change')
      return () => {
        schemaOnly.delete(definition.name)
        emit('tools/change')
      }
    },
    setSchemasError(error) {
      schemasError = error
      emit('tools/change')
    },
    async call(agent, name, args) {
      if (!visibleNames(agent).includes(name)) throw new Error(`tool is hidden: ${name}`)
      return definitions.get(name).execute(args, { agent, signal: new AbortController().signal })
    }
  }
}

function install(host) {
  return installUniversalManager(createUniversalDshAdapter(host.ctx))
}

function createTwoServerHost() {
  const host = createHost()
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo', 'echo alpha'))
  host.register(eagerTool('mcp__beta__search', 'search beta'))
  return { host, disposeManager }
}

function createFiberHost() {
  const originalTools = {}
  const definitions = new Map()
  const listeners = new Map()
  const fibers = new Map()

  function emit(event, payload) {
    for (const record of [...(listeners.get(event) ?? [])]) record.handler(payload)
  }

  function contextFor(name) {
    const resources = new Set()
    fibers.set(name, resources)
    const tools = new Proxy(originalTools, {
      get(target, property, receiver) {
        if (property === Symbol.for('cordis.original')) return target
        if (property === 'schemas') {
          return () => [...definitions.values()].map(({ definition }) => {
            const { name, description, parameters } = definition
            return { name, description, parameters }
          })
        }
        if (property === 'get') return toolName => definitions.get(toolName)?.definition
        if (property !== 'register') return Reflect.get(target, property, receiver)
        return definition => {
          if (definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
          definitions.set(definition.name, { definition, fiber: name })
          emit('tools/change')
          let active = true
          const dispose = () => {
            if (!active) return
            active = false
            resources.delete(dispose)
            if (definitions.get(definition.name)?.definition === definition) definitions.delete(definition.name)
            emit('tools/change')
          }
          resources.add(dispose)
          return dispose
        }
      }
    })
    return {
      tools,
      logger: { info() {}, warn() {}, error() {} },
      on(event, handler) {
        let bucket = listeners.get(event)
        if (bucket === undefined) listeners.set(event, bucket = new Set())
        const listener = { fiber: name, handler }
        bucket.add(listener)
        let active = true
        const dispose = () => {
          if (!active) return
          active = false
          resources.delete(dispose)
          bucket.delete(listener)
        }
        resources.add(dispose)
        return dispose
      },
      effect() { return () => {} }
    }
  }

  function createAgent(id) {
    const restrictions = new Set()
    return {
      id,
      restrictions,
      ctx: {
        tools: {
          restrict({ deny }) {
            const restriction = new Set(deny)
            restrictions.add(restriction)
            return () => restrictions.delete(restriction)
          }
        }
      }
    }
  }

  function visibleNames(agent) {
    const denied = new Set([...agent.restrictions].flatMap(item => [...item]))
    return [...definitions.keys()].filter(name => !denied.has(name)).sort()
  }

  return {
    contextFor,
    createAgent,
    visibleNames,
    definitions,
    emit,
    registerProvider(definition) {
      if (definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
      definitions.set(definition.name, { definition, fiber: 'provider' })
      emit('tools/change')
    },
    unloadFiber(name) {
      for (const dispose of [...fibers.get(name)].reverse()) dispose()
    },
    listenerFibers(event) {
      return [...(listeners.get(event) ?? [])].map(record => record.fiber)
    }
  }
}

test('cold agents see only the router and disclosure is isolated to one agent', async () => {
  const { host, disposeManager } = createTwoServerHost()
  const first = host.createAgent('first')
  const second = host.createAgent('second')
  host.emit('agent/created', { agent: first })
  host.emit('agent/created', { agent: second })

  assert.deepEqual(host.visibleNames(first), [ROUTER_TOOL_NAME])
  assert.deepEqual(host.visibleNames(second), [ROUTER_TOOL_NAME])
  await host.call(first, ROUTER_TOOL_NAME, { query: 'echo alpha' })
  assert.deepEqual(host.visibleNames(first), [ROUTER_TOOL_NAME, 'mcp__alpha__echo'].sort())
  assert.deepEqual(host.visibleNames(second), [ROUTER_TOOL_NAME])
  disposeManager()
})

test('a second route replaces the selected server and turn stopping hides both again', async () => {
  const { host, disposeManager } = createTwoServerHost()
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })

  await host.call(agent, ROUTER_TOOL_NAME, { query: 'alpha', serverName: 'alpha' })
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME, 'mcp__alpha__echo'].sort())
  await host.call(agent, ROUTER_TOOL_NAME, { query: 'beta', serverName: 'beta' })
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME, 'mcp__beta__search'].sort())
  host.emit('agent/turn-stopping', { agent })
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  disposeManager()
})

test('agent disposal lifts its restriction exactly once', () => {
  const { host, disposeManager } = createTwoServerHost()
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  const before = host.counters.restrictionDisposals

  host.emit('agent/disposed', { agent })
  host.emit('agent/disposed', { agent })

  assert.equal(host.counters.restrictionDisposals, before + 1)
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  disposeManager()
})

test('dynamic registration is hidden synchronously and removal clears a selected server', async () => {
  const host = createHost()
  const disposeManager = install(host)
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  const disposeAlpha = host.register(eagerTool('mcp__alpha__echo', 'echo alpha'))

  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  await host.call(agent, ROUTER_TOOL_NAME, { query: 'alpha', serverName: 'alpha' })
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  disposeAlpha()
  host.register(eagerTool('mcp__beta__search', 'search beta'))
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  disposeManager()
})

test('tool-list updates replace the catalog without duplicate router registration', async () => {
  const host = createHost()
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__one', 'alpha one'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  host.register(eagerTool('mcp__alpha__two', 'alpha two'))

  assert.equal(host.counters.routerRegistrations, 1)
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  await host.call(agent, ROUTER_TOOL_NAME, { query: 'alpha', serverName: 'alpha' })
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME, 'mcp__alpha__one', 'mcp__alpha__two'].sort())
  disposeManager()
})

test('manager owners share listeners and router until final cleanup restores all tools', () => {
  const host = createHost()
  const first = install(host)
  const second = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })

  assert.equal(host.counters.routerRegistrations, 1)
  assert.equal(host.counters.listenerRegistrations, 4)
  first()
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  assert.equal(host.counters.listenerDisposals, 4)
  assert.equal(host.counters.listenerRegistrations, 8)
  second()
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  assert.equal(host.definitions.has(ROUTER_TOOL_NAME), false)
  assert.equal(host.counters.listenerDisposals, 8)
})

test('resource ownership transfers across Cordis fibers without exposing already-restricted agents', () => {
  const host = createFiberHost()
  const firstCtx = host.contextFor('first')
  const secondCtx = host.contextFor('second')
  const disposeFirst = installUniversalManager(createUniversalDshAdapter(firstCtx))
  const disposeSecond = installUniversalManager(createUniversalDshAdapter(secondCtx))
  host.registerProvider(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })

  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  assert.equal(host.definitions.get(ROUTER_TOOL_NAME).fiber, 'first')
  disposeFirst()
  host.unloadFiber('first')

  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  assert.equal(host.definitions.get(ROUTER_TOOL_NAME).fiber, 'second')
  for (const event of ['tools/change', 'agent/created', 'agent/turn-stopping', 'agent/disposed']) {
    assert.deepEqual(host.listenerFibers(event), ['second'])
  }

  host.registerProvider(eagerTool('mcp__beta__search'))
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  disposeSecond()
  host.unloadFiber('second')
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  assert.equal(host.definitions.has(ROUTER_TOOL_NAME), false)
})

test('nonstandard, unresolved, native-router-colliding, and atomic-invalid tools pass through', () => {
  const host = createHost()
  host.register(eagerTool(ROUTER_TOOL_NAME, 'native router'))
  host.register(eagerTool('mcp_bad_name'))
  host.register(eagerTool('mcp__bad name__tool'))
  host.register(eagerTool('mcp__alpha__valid'))
  host.addUnresolvedSchema(eagerTool('mcp__alpha__ghost'))
  host.addUnresolvedSchema(eagerTool('mcp__broken__ghost'))

  const disposeManager = install(host)
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })

  assert.deepEqual(host.visibleNames(agent), [
    ROUTER_TOOL_NAME,
    'mcp_bad_name',
    'mcp__bad name__tool',
    'mcp__alpha__ghost',
    'mcp__alpha__valid',
    'mcp__broken__ghost'
  ].sort())
  assert.equal(host.counters.routerRegistrations, 1, 'only the pre-existing native router was registered')
  assert.doesNotThrow(disposeManager)
})

test('an agent without scoped restrict remains unchanged and logs one bounded error', () => {
  const { host, disposeManager } = createTwoServerHost()
  const agent = host.createAgent('unsupported', { restrict: false })
  host.emit('agent/created', { agent })
  host.emit('tools/change')

  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  assert.equal(host.logs.filter(([, message]) => message.includes('scoped disclosure unavailable')).length, 1)
  assert.equal(host.logs.some(([, message]) => message.includes('mcp__alpha__echo')), false)
  disposeManager()
})

test('a thrown restriction replacement lifts the previous restriction and fails open', () => {
  let rejectNext = false
  const host = createHost({
    restrictionFactory() {
      if (rejectNext) {
        rejectNext = false
        return new Error('restriction rejected')
      }
    }
  })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  rejectNext = true
  host.register(eagerTool('mcp__beta__search'))

  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  assert.ok(host.visibleNames(agent).includes('mcp__beta__search'))
  assert.equal(agent.restrictions.size, 0)
  disposeManager()
})

test('passive disclosure failure stays unrestricted for the turn and retries at the next boundary', async () => {
  let rejectDisclosure = false
  const host = createHost({
    restrictionFactory({ deny }) {
      if (rejectDisclosure && deny.length === 1 && deny[0] === 'mcp__beta__search') {
        rejectDisclosure = false
        return new Error('disclosure rejected')
      }
    }
  })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo', 'echo alpha'))
  host.register(eagerTool('mcp__beta__search', 'search beta'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  rejectDisclosure = true

  await assert.rejects(
    host.call(agent, ROUTER_TOOL_NAME, { query: 'alpha', serverName: 'alpha' }),
    /disclosure rejected/
  )
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  host.emit('tools/change')
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))

  host.emit('agent/turn-stopping', { agent })
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  await host.call(agent, ROUTER_TOOL_NAME, { query: 'alpha', serverName: 'alpha' })
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  disposeManager()
})

test('catalog uncertainty immediately fails open, redacts errors, and retries after a turn boundary', () => {
  const host = createHost()
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])

  host.setSchemasError(new Error('https://secret.invalid/?token=credential mcp__alpha__echo'))
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  assert.equal(host.logs.some(([, message]) => message.includes('secret.invalid')), false)
  assert.equal(host.logs.some(([, message]) => message.includes('mcp__alpha__echo')), false)

  host.setSchemasError(undefined)
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'), 'bypass remains active for this turn')
  host.emit('agent/turn-stopping', { agent })
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  disposeManager()
})

test('a dynamic native router collision fails open synchronously and removal re-admits safely', async () => {
  const host = createHost()
  const adapter = createDshAdapter(host.ctx)
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo', 'echo alpha'))
  host.register(eagerTool('mcp__beta__search', 'search beta'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])

  const native = eagerTool(
    ROUTER_TOOL_NAME,
    'native collision',
    async () => ({ content: [{ type: 'text', text: 'native router really executed' }] })
  )
  const disposeNative = registerRouterCompatibleTool(adapter, native)

  assert.deepEqual(host.visibleNames(agent), [
    ROUTER_TOOL_NAME,
    'mcp__alpha__echo',
    'mcp__beta__search'
  ].sort())
  const nativeResult = await host.call(agent, ROUTER_TOOL_NAME, { query: 'alpha' })
  assert.equal(nativeResult.content[0].text, 'native router really executed')

  disposeNative()
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])
  const routed = await host.call(agent, ROUTER_TOOL_NAME, { query: 'alpha', serverName: 'alpha' })
  assert.match(routed.content[0].text, /alpha/)
  disposeManager()
})

test('an unrelated passive namespace colliding with a managed server stays passthrough on activation failure', async () => {
  const host = createHost()
  const adapter = createDshAdapter(host.ctx)
  const disposeManaged = registerRouterServer(adapter, {
    serverName: 'same',
    routingHints: [],
    getCatalog: () => [{ name: 'mcp__same__managed', description: 'managed' }],
    activate: async () => { throw new Error('managed activation failed') }
  })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__same__third_party', 'third-party eager tool'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })

  assert.ok(host.visibleNames(agent).includes('mcp__same__third_party'))
  await assert.rejects(
    host.call(agent, ROUTER_TOOL_NAME, { query: 'managed', serverName: 'same' }),
    /managed activation failed/
  )
  assert.ok(host.visibleNames(agent).includes('mcp__same__third_party'))
  disposeManager()
  disposeManaged()
})

test('transient exact-definition verification failure returns a disposer and leaves no provenance residue', () => {
  let payloadReads = 0
  const host = createHost({
    getToolFactory({ name }) {
      if (name !== 'mcp__same__managed') return undefined
      payloadReads += 1
      if (payloadReads === 2) return new Error('transient exact-definition read failed')
    }
  })
  const adapter = createDshAdapter(host.ctx)
  const disposeManaged = registerRouterServer(adapter, {
    serverName: 'same',
    routingHints: [],
    getCatalog: () => [{ name: 'mcp__same__managed', description: 'managed' }],
    activate: async () => 'managed'
  })
  const disposeManager = install(host)
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })

  let disposePublished
  assert.doesNotThrow(() => {
    disposePublished = registerRouterCompatibleTool(adapter, eagerTool('mcp__same__managed'))
  })
  assert.equal(typeof disposePublished, 'function')
  assert.ok(host.visibleNames(agent).includes('mcp__same__managed'), 'uncertain provenance fails open')
  host.emit('agent/turn-stopping', { agent })
  assert.deepEqual(host.visibleNames(agent), [ROUTER_TOOL_NAME])

  disposePublished()
  assert.equal(host.definitions.has('mcp__same__managed'), false)
  const disposeAgain = registerRouterCompatibleTool(adapter, eagerTool('mcp__same__managed'))
  disposeAgain()
  assert.equal(host.definitions.has('mcp__same__managed'), false)
  disposeManager()
  disposeManaged()
})

test('a transiently throwing old restriction handle is retained and retried during fail-open', () => {
  const disposalAttempts = new Map()
  const host = createHost({
    restrictionDisposeFactory({ defaultDispose, attempt }) {
      return () => {
        disposalAttempts.set(attempt, (disposalAttempts.get(attempt) ?? 0) + 1)
        if (attempt === 1 && disposalAttempts.get(attempt) === 1) throw new Error('old transient dispose')
        defaultDispose()
      }
    }
  })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  host.register(eagerTool('mcp__beta__search'))

  assert.equal(disposalAttempts.get(1), 2)
  assert.equal(agent.restrictions.size, 0)
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  disposeManager()
})

test('a transiently throwing current restriction survives agent disposal for cleanup retry', () => {
  const disposalAttempts = new Map()
  const host = createHost({
    restrictionDisposeFactory({ defaultDispose, attempt }) {
      return () => {
        disposalAttempts.set(attempt, (disposalAttempts.get(attempt) ?? 0) + 1)
        if (attempt === 1 && disposalAttempts.get(attempt) === 1) throw new Error('current transient dispose')
        defaultDispose()
      }
    }
  })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })

  host.emit('agent/disposed', { agent })
  assert.equal(agent.restrictions.size, 1)
  assert.doesNotThrow(disposeManager)
  assert.equal(disposalAttempts.get(1), 2)
  assert.equal(agent.restrictions.size, 0)
})

test('duplicate agent disposal retries and releases a retired transient restriction immediately', () => {
  let disposalAttempts = 0
  const host = createHost({
    restrictionDisposeFactory({ defaultDispose }) {
      return () => {
        disposalAttempts += 1
        if (disposalAttempts === 1) throw new Error('transient retired restriction')
        defaultDispose()
      }
    }
  })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })

  host.emit('agent/disposed', { agent })
  assert.equal(agent.restrictions.size, 1)
  host.emit('agent/disposed', { agent })
  assert.equal(agent.restrictions.size, 0)
  assert.equal(disposalAttempts, 2)
  disposeManager()
  assert.equal(disposalAttempts, 2, 'successfully retired record is not retained until manager cleanup')
})

test('fail-open reports incomplete restriction cleanup without claiming the agent is unrestricted', () => {
  const host = createHost({
    restrictionDisposeFactory() {
      return () => { throw new Error('permanent restriction') }
    }
  })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  host.setSchemasError(new Error('force fail-open'))

  assert.equal(host.logs.some(([, message]) => message.includes('cleanup incomplete')), true)
  assert.equal(host.logs.some(([, message]) => message.includes('agent left unrestricted')), false)
  assert.throws(disposeManager, /universal MCP manager cleanup failed/)
})

test('a permanently throwing old restriction is retained while the new handle is released', () => {
  const disposalAttempts = new Map()
  const host = createHost({
    restrictionDisposeFactory({ defaultDispose, attempt }) {
      return () => {
        disposalAttempts.set(attempt, (disposalAttempts.get(attempt) ?? 0) + 1)
        if (attempt === 1) throw new Error('old permanent dispose')
        defaultDispose()
      }
    }
  })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  host.register(eagerTool('mcp__beta__search'))

  assert.equal(agent.restrictions.size, 1, 'only the permanently failing old handle remains')
  assert.equal(disposalAttempts.get(2), 1, 'the new handle was released by fail-open')
  host.emit('agent/disposed', { agent })
  assert.throws(disposeManager, /universal MCP manager cleanup failed/)
  assert.ok(disposalAttempts.get(1) >= 4)
})

test('a permanently throwing new restriction remains tracked after later fail-open', () => {
  const disposalAttempts = new Map()
  const host = createHost({
    restrictionDisposeFactory({ defaultDispose, attempt }) {
      return () => {
        disposalAttempts.set(attempt, (disposalAttempts.get(attempt) ?? 0) + 1)
        if (attempt === 2) throw new Error('new permanent dispose')
        defaultDispose()
      }
    }
  })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })
  host.register(eagerTool('mcp__beta__search'))
  host.setSchemasError(new Error('force fail-open'))

  assert.equal(agent.restrictions.size, 1)
  host.emit('agent/disposed', { agent })
  assert.throws(disposeManager, /universal MCP manager cleanup failed/)
  assert.ok(disposalAttempts.get(2) >= 3)
})

test('a permanently throwing restriction is retained across fail-open, agent disposal, and final cleanup', () => {
  let disposalAttempts = 0
  const host = createHost({
    restrictionDisposeFactory() {
      return () => {
        disposalAttempts += 1
        throw new Error('permanent restriction dispose')
      }
    }
  })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })

  host.setSchemasError(new Error('catalog failed'))
  host.emit('agent/disposed', { agent })
  assert.throws(disposeManager, error => {
    assert.ok(error instanceof AggregateError)
    assert.ok(error.errors.some(item => /permanent restriction dispose/.test(item.message)))
    return true
  })
  assert.ok(disposalAttempts >= 3)
  assert.equal(agent.restrictions.size, 1)
  const beforeRetry = disposalAttempts
  assert.throws(disposeManager, /cleanup retry failed/)
  assert.equal(disposalAttempts, beforeRetry + 1)
})

test('cleanup attempts every disposer and throws AggregateError after listener cleanup failure', () => {
  const host = createHost({ listenerDisposeThrowsFor: 'agent/created' })
  const disposeManager = install(host)
  host.register(eagerTool('mcp__alpha__echo'))
  const agent = host.createAgent('agent')
  host.emit('agent/created', { agent })

  assert.throws(disposeManager, error => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.errors[0].message, /listener dispose failed/)
    return true
  })
  assert.equal(agent.restrictions.size, 0)
  assert.equal(host.counters.listenerDisposals, 4)
  assert.equal(host.definitions.has(ROUTER_TOOL_NAME), false)
  assert.doesNotThrow(disposeManager)
})
