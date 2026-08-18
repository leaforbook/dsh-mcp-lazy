import assert from 'node:assert/strict'
import test from 'node:test'

import { createDshAdapter } from '../lib/dsh-adapter.js'

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
