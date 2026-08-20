import assert from 'node:assert/strict'
import test from 'node:test'

import { createDshAdapter, createUniversalDshAdapter } from '../lib/dsh-adapter.js'
import { registerRouterServer } from '../lib/tool-router.js'

function supportedContext() {
  const calls = []
  const tools = { register(definition) { calls.push(['register', definition.name]); return () => calls.push(['dispose', definition.name]) } }
  return {
    calls,
    tools,
    logger: {
      info(message) { calls.push(['info', message]) },
      warn(message) { calls.push(['warn', message]) },
      error(message) { calls.push(['error', message]) }
    },
    on(event, handler) { calls.push(['on', event, handler]) },
    effect(factory, label) { calls.push(['effect', label, factory]) }
  }
}

function supportedUniversalContext({ schemas = true, get = true, restrict = true } = {}) {
  const ctx = supportedContext()
  const definitions = [{ name: 'ordinary' }]
  const restrictions = []
  if (schemas) ctx.tools.schemas = () => definitions
  if (get) ctx.tools.get = (name) => definitions.find((definition) => definition.name === name)
  const agent = { restrictions, ctx: { tools: {} } }
  if (restrict) {
    agent.ctx.tools.restrict = ({ deny }) => {
      restrictions.push(deny)
      return () => restrictions.pop()
    }
  }
  ctx.createAgent = () => agent
  return ctx
}

test('universal adapter projects global schemas and scoped restrictions', () => {
  const ctx = supportedUniversalContext()
  const adapter = createUniversalDshAdapter(ctx)
  const agent = ctx.createAgent('a')
  assert.equal(adapter.supported, true)
  assert.deepEqual(adapter.listToolSchemas().map((schema) => schema.name), ['ordinary'])
  assert.equal(adapter.getTool('ordinary').name, 'ordinary')
  const lift = adapter.restrictAgentTools(agent, ['mcp__alpha__one'])
  assert.deepEqual(agent.restrictions, [['mcp__alpha__one']])
  lift()
  assert.deepEqual(agent.restrictions, [])
})

for (const [name, options, missing] of [
  ['tools.schemas', { schemas: false }, 'ctx.tools.schemas'],
  ['tools.get', { get: false }, 'ctx.tools.get']
]) {
  test(`universal adapter reports missing ${name} without weakening base support`, () => {
    const ctx = supportedUniversalContext(options)
    const adapter = createUniversalDshAdapter(ctx)
    assert.equal(adapter.supported, false)
    assert.match(adapter.reason, new RegExp(missing.replace('.', '\\.') ))
    assert.equal(createDshAdapter(ctx).supported, true)
  })
}

test('universal adapter reports scoped restriction failure without mutating server adapter', () => {
  const ctx = supportedUniversalContext({ restrict: false })
  const adapter = createUniversalDshAdapter(ctx)
  const agent = ctx.createAgent('a')
  assert.equal(adapter.supported, true)
  assert.throws(() => adapter.restrictAgentTools(agent, ['mcp__alpha__one']), /agent scoped tools\.restrict is unavailable/)
  assert.equal(adapter.listToolSchemas()[0].name, 'ordinary')
})

test('supported DSH context is exposed through the stable adapter contract', () => {
  const ctx = supportedContext()
  const adapter = createDshAdapter(ctx)
  assert.equal(adapter.supported, true)
  assert.equal(adapter.identity, ctx.tools)
  const dispose = adapter.registerTool({ name: 'demo' })
  dispose()
  adapter.on('agent/turn-stopping', () => {})
  adapter.effect(() => () => {}, 'state')
  adapter.log('warn', 'message')
  assert.deepEqual(ctx.calls.map((item) => item.slice(0, 2)), [
    ['register', 'demo'],
    ['dispose', 'demo'],
    ['on', 'agent/turn-stopping'],
    ['effect', 'state'],
    ['warn', 'message']
  ])
})

test('Cordis service proxies share one router registration', () => {
  const definitions = new Map()
  const originalTools = {
    register(definition) {
      if (definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    }
  }
  const context = () => ({
    ...supportedContext(),
    tools: new Proxy(originalTools, {
      get(target, property, receiver) {
        if (property === Symbol.for('cordis.original')) return target
        return Reflect.get(target, property, receiver)
      }
    })
  })
  const unregisterFirst = registerRouterServer(createDshAdapter(context()), {
    serverName: 'first',
    routingHints: [],
    getCatalog: () => [],
    activate: async () => 'first active'
  })
  const unregisterSecond = registerRouterServer(createDshAdapter(context()), {
    serverName: 'second',
    routingHints: [],
    getCatalog: () => [],
    activate: async () => 'second active'
  })

  assert.deepEqual([...definitions.keys()], ['mcp__router__search_and_activate'])
  unregisterSecond()
  unregisterFirst()
  assert.equal(definitions.size, 0)
})

test('router publication moves to a surviving Cordis fiber after its first owner unloads', async () => {
  const definitions = new Map()
  const originalTools = { register() {} }
  const fibers = new Map()

  function contextFor(fiberName) {
    const resources = []
    fibers.set(fiberName, resources)
    const tools = new Proxy(originalTools, {
      get(target, property, receiver) {
        if (property === Symbol.for('cordis.original')) return target
        if (property !== 'register') return Reflect.get(target, property, receiver)
        return (definition) => {
          if (definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
          definitions.set(definition.name, { definition, fiberName })
          let active = true
          const dispose = () => {
            if (!active) return
            active = false
            if (definitions.get(definition.name)?.definition === definition) definitions.delete(definition.name)
          }
          resources.push(dispose)
          return dispose
        }
      }
    })
    return { ...supportedContext(), tools }
  }

  function unloadFiber(fiberName) {
    for (const dispose of [...fibers.get(fiberName)].reverse()) dispose()
  }

  const unregisterFirst = registerRouterServer(createDshAdapter(contextFor('first')), {
    serverName: 'first',
    routingHints: [],
    getCatalog: () => [],
    activate: async () => 'first active'
  })
  const unregisterSecond = registerRouterServer(createDshAdapter(contextFor('second')), {
    serverName: 'second',
    routingHints: [],
    getCatalog: () => [],
    activate: async () => 'second active'
  })

  assert.equal(definitions.get('mcp__router__search_and_activate').fiberName, 'first')
  unloadFiber('first')
  assert.equal(definitions.size, 0, 'Cordis removes registrations owned by the unloading fiber')

  unregisterFirst()
  const surviving = definitions.get('mcp__router__search_and_activate')
  assert.equal(surviving.fiberName, 'second')
  const routed = await surviving.definition.execute(
    { query: 'anything', serverName: 'second' },
    { agent: { id: 'survivor' }, signal: new AbortController().signal }
  )
  assert.match(routed.content[0].text, /second/)

  unregisterSecond()
  assert.equal(definitions.size, 0)
})

test('Cordis service proxies share an opaque identity without exposing the original service', () => {
  const originalTools = {
    secret: 'must-not-escape',
    register() { return () => {} }
  }
  const proxiedTools = () => new Proxy(originalTools, {
    get(target, property, receiver) {
      if (property === Symbol.for('cordis.original')) return target
      return Reflect.get(target, property, receiver)
    }
  })

  const first = createDshAdapter({ ...supportedContext(), tools: proxiedTools() })
  const second = createDshAdapter({ ...supportedContext(), tools: proxiedTools() })

  assert.equal(first.identity, second.identity)
  assert.notEqual(first.identity, originalTools)
  assert.equal(first.identity.secret, undefined)
})

test('Cordis function originals also share an opaque identity token', () => {
  function originalTools() {}
  originalTools.register = () => () => {}
  const proxiedTools = () => new Proxy(originalTools, {
    get(target, property, receiver) {
      if (property === Symbol.for('cordis.original')) return target
      return Reflect.get(target, property, receiver)
    }
  })

  const first = createDshAdapter({ ...supportedContext(), tools: proxiedTools() })
  const second = createDshAdapter({ ...supportedContext(), tools: proxiedTools() })

  assert.equal(first.identity, second.identity)
  assert.notEqual(first.identity, originalTools)
})

test('invalid Cordis originals safely preserve the proxy identity with one bounded read', () => {
  for (const original of [null, 0, false, 'primitive', Symbol('primitive')]) {
    let originalReads = 0
    let tools
    tools = new Proxy(supportedContext().tools, {
      get(target, property, receiver) {
        if (property === Symbol.for('cordis.original')) {
          originalReads += 1
          return original
        }
        return Reflect.get(target, property, receiver)
      }
    })

    const adapter = createDshAdapter({ ...supportedContext(), tools })
    assert.equal(adapter.identity, tools)
    assert.equal(originalReads, 1)
  }
})

test('a self-referential Cordis original safely preserves the proxy identity', () => {
  let originalReads = 0
  let tools
  tools = new Proxy(supportedContext().tools, {
    get(target, property, receiver) {
      if (property === Symbol.for('cordis.original')) {
        originalReads += 1
        return tools
      }
      return Reflect.get(target, property, receiver)
    }
  })

  const adapter = createDshAdapter({ ...supportedContext(), tools })

  assert.equal(adapter.identity, tools)
  assert.equal(originalReads, 1)
})

test('a throwing Cordis original getter safely preserves the service identity', () => {
  const tools = supportedContext().tools
  let originalReads = 0
  Object.defineProperty(tools, Symbol.for('cordis.original'), {
    get() {
      originalReads += 1
      throw new Error('blocked original')
    }
  })

  const adapter = createDshAdapter({ ...supportedContext(), tools })

  assert.equal(adapter.identity, tools)
  assert.equal(originalReads, 1)
})

for (const [name, mutate, missing] of [
  ['tools.register', (ctx) => { delete ctx.tools.register }, 'ctx.tools.register'],
  ['on', (ctx) => { delete ctx.on }, 'ctx.on'],
  ['effect', (ctx) => { delete ctx.effect }, 'ctx.effect']
]) {
  test(`missing ${name} is reported without throwing`, () => {
    const ctx = supportedContext()
    mutate(ctx)
    const adapter = createDshAdapter(ctx)
    assert.equal(adapter.supported, false)
    assert.match(adapter.reason, new RegExp(missing.replace('.', '\\.')))
    assert.equal(ctx.calls.filter(([level]) => level === 'error').length, 1)
  })
}
