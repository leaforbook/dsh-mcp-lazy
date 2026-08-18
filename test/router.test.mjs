import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ROUTER_TOOL_NAME,
  registerRouterCompatibleTool,
  registerRouterServer,
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

test('explicit serverName and public tool prefix select exact servers', () => {
  assert.equal(selectRoute(entries, { query: 'anything', serverName: 'context7' }).entry.serverName, 'context7')
  assert.equal(selectRoute(entries, { query: '调用 mcp__chrome-devtools__take_screenshot' }).entry.serverName, 'chrome-devtools')
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

test('one router tool is shared and disposed after the last server leaves', async () => {
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
  assert.equal(routerDisposals, 0)
  second()
  assert.equal(routerDisposals, 1)
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
