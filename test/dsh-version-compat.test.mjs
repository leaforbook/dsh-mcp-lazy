import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)

test('plugin imports host-owned peers for the requested DSH version', async (t) => {
  const expected = process.env.DSH_COMPAT_VERSION
  if (!expected) return t.skip('DSH_COMPAT_VERSION is only set by compatibility CI')
  const { apply } = await import('../lib/index.js')
  const actual = require('@deepseek-ai/dsh/package.json').version
  assert.equal(actual, expected)
  await assert.doesNotReject(() => apply({}, undefined))

  const definitions = new Map()
  const cleanups = []
  const listeners = new Map()
  const emit = (event, payload) => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload)
  }
  const context = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        emit('tools/change')
        return () => {
          definitions.delete(definition.name)
          emit('tools/change')
        }
      },
      schemas() {
        return [...definitions.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
      },
      get(name) {
        return definitions.get(name)
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) {
      let handlers = listeners.get(event)
      if (handlers === undefined) listeners.set(event, handlers = new Set())
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    effect(factory) {
      const cleanup = factory()
      cleanups.push(async () => {
        await new Promise((resolve) => setImmediate(resolve))
        return cleanup?.()
      })
    }
  }
  const restrictions = new Set()
  const agent = {
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
  const visibleNames = () => {
    const denied = new Set([...restrictions].flatMap(restriction => [...restriction]))
    return [...definitions.keys()].filter(name => !denied.has(name)).sort()
  }

  await assert.doesNotReject(() => apply(context, { mode: 'manager' }))
  const disposePassive = context.tools.register({
    name: 'mcp__passive__echo',
    description: 'compatibility passive tool',
    parameters: { type: 'object' },
    execute: async () => ({ content: [{ type: 'text', text: 'passive' }] })
  })
  emit('agent/created', { agent })
  assert.deepEqual(visibleNames(), ['mcp__router__search_and_activate'])

  await assert.doesNotReject(() => apply(context, {
    transport: 'stdio',
    serverName: 'compat',
    command: process.execPath,
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 1000,
    connectTimeoutMs: 1000,
    discoveryTimeoutMs: 1000,
    maxToolListPages: 2,
    reconnectAttempts: 0,
    autoActivate: false,
    releaseOnTurnEnd: true,
    warmIdleMs: 0,
    routingHints: []
  }))
  assert.ok(definitions.has('mcp__compat__activate'))
  assert.ok(definitions.has('mcp__compat__deactivate'))
  assert.ok(definitions.has('mcp__router__search_and_activate'))
  for (const cleanup of cleanups.reverse()) await cleanup?.()
  assert.ok(visibleNames().includes('mcp__passive__echo'))
  disposePassive()
  assert.equal(definitions.size, 0)
})
