import assert from 'node:assert/strict'
import test from 'node:test'

import { createUniversalDshAdapter } from '../lib/dsh-adapter.js'
import { installUniversalManager } from '../lib/universal-manager.js'
import { ROUTER_TOOL_NAME } from '../lib/tool-router.js'

function eagerTool(name, description = name, execute = async () => ({ content: [] })) {
  return { name, description, parameters: { type: 'object' }, execute }
}

function createHost({ listenerDisposeThrowsFor, restrictionFactory } = {}) {
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
        return () => {
          if (!active) return
          active = false
          counters.restrictionDisposals += 1
          restriction.active = false
          restrictions.delete(restriction)
        }
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
  assert.equal(host.counters.listenerDisposals, 0)
  second()
  assert.ok(host.visibleNames(agent).includes('mcp__alpha__echo'))
  assert.equal(host.definitions.has(ROUTER_TOOL_NAME), false)
  assert.equal(host.counters.listenerDisposals, 4)
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
