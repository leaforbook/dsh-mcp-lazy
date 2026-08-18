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
  const context = {
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    effect(factory) {
      const cleanup = factory()
      cleanups.push(async () => {
        await new Promise((resolve) => setImmediate(resolve))
        return cleanup?.()
      })
    }
  }
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
  assert.equal(definitions.size, 0)
})
