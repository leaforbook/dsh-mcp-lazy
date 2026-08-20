import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ROUTER_TOOL_NAME,
  registerRouterCompatibleTool,
  registerRouterServer,
  registerRouterVisibility,
  selectRoute
} from '../lib/tool-router.js'

const entries = [
  {
    serverName: 'chrome-devtools',
    routingHints: ['浏览器', '页面调试', 'network'],
    getCatalog: () => [{ name: 'take_screenshot', description: 'capture a page image' }]
  },
  {
    serverName: 'playwright',
    routingHints: ['浏览器', '网页自动化'],
    getCatalog: () => [{ name: 'browser_click', description: 'click a page element' }]
  },
  {
    serverName: 'context7',
    routingHints: ['文档', 'SDK'],
    getCatalog: () => [{ name: 'query_docs', description: 'query library documentation' }]
  }
]

function nativeRouterDefinition() {
  return {
    name: ROUTER_TOOL_NAME,
    description: 'native collision tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'native' }] })
  }
}

function throwingRegistryAdapter(identity, {
  throwNativeDisposeOnce = false,
  throwSharedDisposeOnce = false
} = {}) {
  const definitions = new Map()
  const disposalAttempts = []
  return {
    adapter: {
      identity,
      registerTool(definition) {
        if (definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
        definitions.set(definition.name, definition)
        return () => {
          disposalAttempts.push(definition.description)
          if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
          if (definition.description === '搜索并激活最匹配的 MCP 服务器。' && throwSharedDisposeOnce) {
            throwSharedDisposeOnce = false
            throw new Error('shared disposer failed')
          }
          if (definition.description === 'native collision tool' && throwNativeDisposeOnce) {
            throwNativeDisposeOnce = false
            throw new Error('native disposer failed')
          }
        }
      }
    },
    definitions,
    disposalAttempts
  }
}

function routerEntry(serverName) {
  return {
    ...entries[0],
    serverName,
    activate: async () => `${serverName} active`
  }
}

test('a visibility controller publishes the router and reveals one passive server', async () => {
  const host = throwingRegistryAdapter({})
  const revealed = []
  const dispose = registerRouterVisibility(host.adapter, {
    getEntries: () => [{
      serverName: 'passive',
      routingHints: [],
      getCatalog: () => [{ name: 'mcp__passive__echo', description: 'echo text' }]
    }],
    reveal: async (agent, serverName) => {
      revealed.push([agent.id, serverName])
      return '1 个工具已披露'
    }
  })
  const result = await host.definitions.get(ROUTER_TOOL_NAME).execute(
    { query: 'echo text' },
    { agent: { id: 'a' }, signal: new AbortController().signal }
  )
  assert.deepEqual(revealed, [['a', 'passive']])
  assert.match(result.content[0].text, /passive/)
  dispose()
  assert.equal(host.definitions.size, 0)
})

test('a managed server wins a passive name and activates before revealing', async () => {
  const host = throwingRegistryAdapter({})
  const calls = []
  const disposeVisibility = registerRouterVisibility(host.adapter, {
    getEntries: () => [{
      serverName: 'same',
      routingHints: [],
      getCatalog: () => [{ name: 'mcp__same__passive', description: 'passive' }]
    }],
    reveal: (agent, serverName) => {
      calls.push(['reveal', agent.id, serverName])
      return '已披露'
    }
  })
  const disposeManaged = registerRouterServer(host.adapter, {
    serverName: 'same',
    routingHints: [],
    getCatalog: () => [{ name: 'mcp__same__managed', description: 'managed' }],
    activate: async (agent) => {
      calls.push(['activate', agent.id, 'same'])
      return '已激活'
    }
  })

  await host.definitions.get(ROUTER_TOOL_NAME).execute(
    { query: 'managed', serverName: 'same' },
    { agent: { id: 'a' }, signal: new AbortController().signal }
  )

  assert.deepEqual(calls, [['activate', 'a', 'same'], ['reveal', 'a', 'same']])
  disposeManaged()
  disposeVisibility()
})

test('a passive reveal rejection rejects router execution', async () => {
  const host = throwingRegistryAdapter({})
  const dispose = registerRouterVisibility(host.adapter, {
    getEntries: () => [{
      serverName: 'failing-passive',
      routingHints: [],
      getCatalog: () => [{ name: 'mcp__failing-passive__tool', description: 'failing tool' }]
    }],
    reveal: async () => { throw new Error('reveal failed') }
  })

  await assert.rejects(
    host.definitions.get(ROUTER_TOOL_NAME).execute(
      { query: 'failing tool' },
      { agent: { id: 'a' }, signal: new AbortController().signal }
    ),
    /reveal failed/
  )
  dispose()
})

test('disposing visibility leaves a managed router entry active', async () => {
  const host = throwingRegistryAdapter({})
  let activations = 0
  const disposeManaged = registerRouterServer(host.adapter, {
    serverName: 'managed',
    routingHints: [],
    getCatalog: () => [{ name: 'mcp__managed__tool', description: 'managed tool' }],
    activate: async () => { activations += 1; return '已激活' }
  })
  const disposeVisibility = registerRouterVisibility(host.adapter, {
    getEntries: () => [],
    reveal: () => '不应调用'
  })

  disposeVisibility()
  assert.ok(host.definitions.has(ROUTER_TOOL_NAME))
  await host.definitions.get(ROUTER_TOOL_NAME).execute(
    { query: 'managed tool' },
    { agent: { id: 'a' }, signal: new AbortController().signal }
  )
  assert.equal(activations, 1)
  disposeManaged()
  assert.equal(host.definitions.size, 0)
})

test('disposing the last managed entry leaves a passive router active', async () => {
  const host = throwingRegistryAdapter({})
  let revealed = 0
  const disposeManaged = registerRouterServer(host.adapter, routerEntry('managed'))
  const disposeVisibility = registerRouterVisibility(host.adapter, {
    getEntries: () => [{
      serverName: 'passive',
      routingHints: [],
      getCatalog: () => [{ name: 'mcp__passive__tool', description: 'passive tool' }]
    }],
    reveal: () => { revealed += 1; return '已披露' }
  })

  disposeManaged()
  assert.ok(host.definitions.has(ROUTER_TOOL_NAME))
  await host.definitions.get(ROUTER_TOOL_NAME).execute(
    { query: 'passive tool' },
    { agent: { id: 'a' }, signal: new AbortController().signal }
  )
  assert.equal(revealed, 1)
  disposeVisibility()
  assert.equal(host.definitions.size, 0)
})

test('duplicate visibility registration preserves the first controller', async () => {
  const host = throwingRegistryAdapter({})
  let firstReveals = 0
  const dispose = registerRouterVisibility(host.adapter, {
    getEntries: () => [{
      serverName: 'first',
      routingHints: [],
      getCatalog: () => [{ name: 'mcp__first__tool', description: 'first tool' }]
    }],
    reveal: () => { firstReveals += 1; return 'first disclosed' }
  })

  assert.throws(
    () => registerRouterVisibility(host.adapter, { getEntries: () => [], reveal: () => 'second disclosed' }),
    /visibility controller is already registered/
  )
  await host.definitions.get(ROUTER_TOOL_NAME).execute(
    { query: 'first tool' },
    { agent: { id: 'a' }, signal: new AbortController().signal }
  )
  assert.equal(firstReveals, 1)
  dispose()
})

function fiberRegistryAdapter(identity, fiberName, state, {
  throwNativeDisposeOnce = false,
  throwSharedDisposeOnce = false
} = {}) {
  return {
    identity,
    registerTool(definition) {
      if (state.definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
      state.definitions.set(definition.name, { definition, fiberName })
      let active = true
      return () => {
        if (!active) return
        active = false
        state.disposals.push([fiberName, definition.description])
        if (state.definitions.get(definition.name)?.definition === definition) {
          state.definitions.delete(definition.name)
        }
        if (definition.description === '搜索并激活最匹配的 MCP 服务器。' && throwSharedDisposeOnce) {
          throwSharedDisposeOnce = false
          throw new Error(`${fiberName} shared disposer failed`)
        }
        if (definition.description === 'native collision tool' && throwNativeDisposeOnce) {
          throwNativeDisposeOnce = false
          throw new Error(`${fiberName} native disposer failed`)
        }
      }
    }
  }
}

test('explicit serverName and public tool prefix select exact servers', () => {
  assert.equal(selectRoute(entries, { query: 'anything', serverName: 'context7' }).entry.serverName, 'context7')
  assert.equal(selectRoute(entries, { query: '调用 mcp__chrome-devtools__take_screenshot' }).entry.serverName, 'chrome-devtools')
})

test('public tool prefixes preserve exact case and never guess an ambiguous case fold', () => {
  const upper = routerEntry('Foo')
  const lower = routerEntry('foo')

  assert.equal(
    selectRoute([upper, lower], { query: '调用 mcp__Foo__take_screenshot' }).entry.serverName,
    'Foo'
  )
  assert.equal(
    selectRoute([upper, lower], { query: '调用 mcp__foo__take_screenshot' }).entry.serverName,
    'foo'
  )

  const ambiguous = selectRoute([upper, lower], { query: '调用 mcp__FOO__take_screenshot' })
  assert.equal(ambiguous.entry, undefined)
  assert.deepEqual(ambiguous.candidates.map((entry) => entry.serverName).sort(), ['Foo', 'foo'])

  assert.equal(
    selectRoute([upper], { query: '调用 mcp__foo__take_screenshot' }).entry.serverName,
    'Foo'
  )
})

test('a unique hint or catalog match selects one server', () => {
  assert.equal(selectRoute(entries, { query: '查询 SDK 文档' }).entry.serverName, 'context7')
  assert.equal(selectRoute(entries, { query: 'take_screenshot 当前页面' }).entry.serverName, 'chrome-devtools')
})

test('zero score and tied top score do not select a server', () => {
  assert.equal(selectRoute(entries, { query: '发送邮件' }).entry, undefined)
  const tied = selectRoute(entries, { query: '浏览器' })
  assert.equal(tied.entry, undefined)
  assert.deepEqual(tied.candidates.map((entry) => entry.serverName), ['chrome-devtools', 'playwright'])
})

test('one router tool is shared and moves owners until the last server leaves', async () => {
  const definitions = new Map()
  let routerRegistrations = 0
  let routerDisposals = 0
  const identity = {}
  const adapter = {
    identity,
    registerTool(definition) {
      routerRegistrations += 1
      definitions.set(definition.name, definition)
      return () => { routerDisposals += 1; definitions.delete(definition.name) }
    }
  }
  const activated = []
  const first = registerRouterServer(adapter, { ...entries[0], activate: async () => { activated.push('chrome-devtools'); return 'chrome active' } })
  const second = registerRouterServer(adapter, { ...entries[2], activate: async () => { activated.push('context7'); return 'context active' } })
  assert.equal(routerRegistrations, 1)
  const result = await definitions.get(ROUTER_TOOL_NAME).execute(
    { query: 'SDK 文档' },
    { agent: { id: 'agent' }, signal: new AbortController().signal }
  )
  assert.deepEqual(activated, ['context7'])
  assert.match(result.content[0].text, /context7/)
  first()
  assert.equal(routerRegistrations, 2)
  assert.equal(routerDisposals, 1)
  second()
  assert.equal(routerDisposals, 2)
})

test('a throwing shared disposer rolls back native handoff without stale ownership', () => {
  const host = throwingRegistryAdapter({}, { throwSharedDisposeOnce: true })
  const unregister = registerRouterServer(host.adapter, routerEntry('throwing-shared'))
  const sharedRouter = host.definitions.get(ROUTER_TOOL_NAME)

  assert.throws(
    () => registerRouterCompatibleTool(host.adapter, nativeRouterDefinition()),
    /shared disposer failed/
  )
  assert.equal(host.definitions.get(ROUTER_TOOL_NAME), sharedRouter)

  const nativeDefinition = nativeRouterDefinition()
  const disposeNative = registerRouterCompatibleTool(host.adapter, nativeDefinition)
  assert.equal(host.definitions.get(ROUTER_TOOL_NAME), nativeDefinition)
  disposeNative()
  assert.equal(host.definitions.get(ROUTER_TOOL_NAME), sharedRouter)
  disposeNative()
  assert.equal(
    host.disposalAttempts.filter((description) => description === 'native collision tool').length,
    1
  )

  unregister()
  assert.equal(host.definitions.size, 0)
  const unregisterAgain = registerRouterServer(host.adapter, routerEntry('after-shared-failure'))
  assert.ok(host.definitions.has(ROUTER_TOOL_NAME))
  unregisterAgain()
  assert.equal(host.definitions.size, 0)
})

test('a throwing native disposer restores the shared router and remains idempotent', () => {
  const host = throwingRegistryAdapter({}, { throwNativeDisposeOnce: true })
  const unregister = registerRouterServer(host.adapter, routerEntry('throwing-native'))
  const sharedRouter = host.definitions.get(ROUTER_TOOL_NAME)
  const disposeNative = registerRouterCompatibleTool(host.adapter, nativeRouterDefinition())

  assert.throws(() => disposeNative(), /native disposer failed/)
  assert.equal(host.definitions.get(ROUTER_TOOL_NAME), sharedRouter)
  disposeNative()
  assert.equal(
    host.disposalAttempts.filter((description) => description === 'native collision tool').length,
    1
  )

  unregister()
  assert.equal(host.definitions.size, 0)
})

test('a throwing final shared disposer removes the registry for a new adapter identity owner', () => {
  const identity = {}
  const firstHost = throwingRegistryAdapter(identity, { throwSharedDisposeOnce: true })
  const unregisterFirst = registerRouterServer(firstHost.adapter, routerEntry('first-owner'))

  assert.throws(() => unregisterFirst(), /shared disposer failed/)
  assert.equal(firstHost.definitions.size, 0)
  assert.doesNotThrow(() => unregisterFirst())

  const secondHost = throwingRegistryAdapter(identity)
  const unregisterSecond = registerRouterServer(secondHost.adapter, routerEntry('second-owner'))
  assert.ok(secondHost.definitions.has(ROUTER_TOOL_NAME))
  assert.equal(firstHost.definitions.size, 0)
  unregisterSecond()
  assert.equal(secondHost.definitions.size, 0)
})

test('removing the shared-router owner transfers publication despite its throwing disposer', () => {
  const identity = {}
  const state = { definitions: new Map(), disposals: [] }
  const first = fiberRegistryAdapter(identity, 'first', state, { throwSharedDisposeOnce: true })
  const second = fiberRegistryAdapter(identity, 'second', state)
  const unregisterFirst = registerRouterServer(first, routerEntry('first'))
  const unregisterSecond = registerRouterServer(second, routerEntry('second'))

  assert.equal(state.definitions.get(ROUTER_TOOL_NAME).fiberName, 'first')
  assert.throws(() => unregisterFirst(), /first shared disposer failed/)
  assert.equal(state.definitions.get(ROUTER_TOOL_NAME).fiberName, 'second')
  assert.doesNotThrow(() => unregisterFirst())
  assert.equal(
    state.disposals.filter(([fiber, description]) => fiber === 'first' && description === '搜索并激活最匹配的 MCP 服务器。').length,
    1
  )

  unregisterSecond()
  assert.equal(state.definitions.size, 0)
})

test('removing a native collision owner restores the shared router through a surviving adapter', () => {
  const identity = {}
  const state = { definitions: new Map(), disposals: [] }
  const first = fiberRegistryAdapter(identity, 'first', state, { throwNativeDisposeOnce: true })
  const second = fiberRegistryAdapter(identity, 'second', state)
  const unregisterFirst = registerRouterServer(first, routerEntry('first-native'))
  const unregisterSecond = registerRouterServer(second, routerEntry('second-survivor'))
  const disposeNative = registerRouterCompatibleTool(first, nativeRouterDefinition())

  assert.equal(state.definitions.get(ROUTER_TOOL_NAME).fiberName, 'first')
  assert.equal(state.definitions.get(ROUTER_TOOL_NAME).definition.description, 'native collision tool')
  assert.throws(() => unregisterFirst(), /first native disposer failed/)
  assert.equal(state.definitions.get(ROUTER_TOOL_NAME).fiberName, 'second')
  assert.equal(state.definitions.get(ROUTER_TOOL_NAME).definition.description, '搜索并激活最匹配的 MCP 服务器。')

  assert.doesNotThrow(() => disposeNative())
  assert.equal(
    state.disposals.filter(([fiber, description]) => fiber === 'first' && description === 'native collision tool').length,
    1
  )

  unregisterSecond()
  assert.equal(state.definitions.size, 0)
})
