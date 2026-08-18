import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, apply } from '../../lib/index.js'

const routerToolName = 'mcp__router__search_and_activate'

const fixture = fileURLToPath(new URL('./dynamic-mcp-server.mjs', import.meta.url))
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-mcp-lazy-host-'))

function createContext() {
  const definitions = new Map()
  const handlers = new Map()
  const cleanups = []
  const logs = []
  const registrations = []
  const disposals = []
  return {
    definitions,
    disposals,
    logs,
    registrations,
    tools: {
      register(definition) {
        if (definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
        definitions.set(definition.name, definition)
        registrations.push(definition.name)
        let active = true
        return () => {
          if (!active) return
          active = false
          disposals.push(definition.name)
          if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
        }
      }
    },
    logger: {
      info(message) { logs.push(`info ${message}`) },
      warn(message) { logs.push(`warn ${message}`) },
      error(message) { logs.push(`error ${message}`) }
    },
    on(event, callback) {
      const callbacks = handlers.get(event) ?? []
      callbacks.push(callback)
      handlers.set(event, callbacks)
    },
    emit(event, payload) {
      for (const callback of handlers.get(event) ?? []) callback(payload)
    },
    effect(callback) {
      cleanups.push(callback())
    },
    cleanup() {
      for (const cleanup of cleanups.reverse()) cleanup?.()
    }
  }
}

function config(stateFile, overrides = {}) {
  return {
    transport: 'stdio',
    serverName: 'lazy-fixture',
    command: process.execPath,
    args: [fixture, stateFile, '0', '0'],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 5000,
    connectTimeoutMs: 5000,
    discoveryTimeoutMs: 5000,
    maxToolListPages: 10,
    reconnectAttempts: 1,
    autoActivate: false,
    releaseOnTurnEnd: false,
    warmIdleMs: 300000,
    routingHints: [],
    ...overrides
  }
}

async function call(context, name, args = {}, agent = {}, signal = new AbortController().signal) {
  const definition = context.definitions.get(name)
  assert.ok(definition, `missing registered tool: ${name}`)
  return definition.execute(args, { agent, signal })
}

async function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out: ${message}`)
}

async function starts(stateFile) {
  try { return Number.parseInt(await readFile(stateFile, 'utf8'), 10) || 0 } catch { return 0 }
}

async function unconfiguredInstanceIsNoOp() {
  const context = createContext()
  await assert.doesNotReject(() => apply(context, undefined))
  assert.equal(context.definitions.size, 0)
  context.cleanup()
}

function configurationDefaults() {
  const stdio = Config({
    transport: 'stdio',
    serverName: 'stdio-defaults',
    command: process.execPath
  })
  const http = Config({
    transport: 'streamable-http',
    serverName: 'http-defaults',
    url: 'http://127.0.0.1:8000/mcp'
  })

  for (const normalized of [stdio, http]) {
    assert.equal(normalized.warmIdleMs, 300000)
    assert.deepEqual(normalized.routingHints, [])
  }
}

async function fullLifecycle() {
  const stateFile = join(tempRoot, 'full-starts')
  await writeFile(stateFile, '0')
  const context = createContext()
  const agent = { id: 'full' }
  await apply(context, config(stateFile, {
    args: [fixture, stateFile, '2', '0'],
    reconnectAttempts: 3
  }))
  assert.ok(context.definitions.has(routerToolName))

  const activation = await call(context, 'mcp__lazy-fixture__activate', {}, agent)
  const activationText = activation.content[0].text
  assert.match(activationText, /5 个工具/)
  assert.doesNotMatch(activationText, /mcp__lazy-fixture__echo/)
  assert.equal((await call(context, 'mcp__lazy-fixture__echo', { text: 'host-ok' }, agent)).content[0].text, 'host-ok')

  await call(context, 'mcp__lazy-fixture__fail_refresh', {}, agent)
  await waitFor(
    () => context.logs.some((entry) => entry.includes('keeping last good catalog')),
    'failed refresh log'
  )
  assert.equal((await call(context, 'mcp__lazy-fixture__initial_only', {}, agent)).content[0].text, 'initial_only')

  await call(context, 'mcp__lazy-fixture__change_catalog', {}, agent)
  await waitFor(() => context.definitions.has('mcp__lazy-fixture__changed_only'), 'changed catalog')
  assert.ok(!context.definitions.has('mcp__lazy-fixture__initial_only'))
  assert.equal((await call(context, 'mcp__lazy-fixture__changed_only', {}, agent)).content[0].text, 'changed_only')

  await call(context, 'mcp__lazy-fixture__disconnect_once', {}, agent)
  await waitFor(
    async () => await starts(stateFile) === 4 && context.definitions.has('mcp__lazy-fixture__echo'),
    'third bounded reconnect attempt succeeds',
    15000
  )
  assert.equal((await call(context, 'mcp__lazy-fixture__echo', { text: 'reconnected' }, agent)).content[0].text, 'reconnected')

  await call(context, 'mcp__lazy-fixture__deactivate', {}, agent)
  assert.deepEqual([...context.definitions.keys()].sort(), [
    'mcp__lazy-fixture__activate',
    'mcp__lazy-fixture__deactivate',
    routerToolName
  ])
  context.cleanup()
}

async function demandDisappearsDuringReconnect() {
  const stateFile = join(tempRoot, 'demand-starts')
  await writeFile(stateFile, '0')
  const context = createContext()
  const agent = { id: 'demand' }
  await apply(context, config(stateFile, {
    args: [fixture, stateFile, '0', '500'],
    reconnectAttempts: 3,
    releaseOnTurnEnd: true
  }))

  await call(context, 'mcp__lazy-fixture__activate', {}, agent)
  await call(context, 'mcp__lazy-fixture__disconnect_once', {}, agent)
  await waitFor(async () => await starts(stateFile) === 2, 'reconnect process starts')
  context.emit('agent/turn-stopping', { agent })
  await waitFor(
    () => !context.definitions.has('mcp__lazy-fixture__echo'),
    'dynamic tools stay unloaded when demand disappears'
  )
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(await starts(stateFile), 2)
  context.cleanup()
}

async function sharedRouterCleanupOrder() {
  const primaryStateFile = join(tempRoot, 'shared-primary-starts')
  const secondaryStateFile = join(tempRoot, 'shared-secondary-starts')
  await Promise.all([
    writeFile(primaryStateFile, '0'),
    writeFile(secondaryStateFile, '0')
  ])
  const context = createContext()
  await apply(context, config(primaryStateFile, {
    serverName: 'primary-fixture',
    routingHints: ['primary fixture']
  }))
  assert.ok(context.definitions.has(routerToolName))
  await apply(context, config(secondaryStateFile, {
    serverName: 'secondary-fixture',
    args: [fixture, secondaryStateFile, '0', '0'],
    routingHints: ['secondary fixture']
  }))

  assert.equal(context.registrations.filter((name) => name === routerToolName).length, 1)
  assert.ok(context.definitions.has('mcp__primary-fixture__activate'))
  assert.ok(context.definitions.has('mcp__primary-fixture__deactivate'))
  assert.ok(context.definitions.has('mcp__secondary-fixture__activate'))
  assert.ok(context.definitions.has('mcp__secondary-fixture__deactivate'))

  const routed = await call(context, routerToolName, { query: 'primary fixture' }, { id: 'shared' })
  assert.match(routed.content[0].text, /primary-fixture/)
  assert.equal(await starts(primaryStateFile), 1)
  assert.equal(await starts(secondaryStateFile), 0)

  context.cleanup()

  assert.equal(context.disposals.filter((name) => name === routerToolName).length, 1)
  assert.ok(
    context.disposals.indexOf(routerToolName) < context.disposals.indexOf('mcp__primary-fixture__echo'),
    'shared router unregisters before the last runtime disposes its remote schemas'
  )
}

async function invalidWarmIdleFallsBackWithoutChangingZero() {
  const fallbackStateFile = join(tempRoot, 'warm-fallback-starts')
  await writeFile(fallbackStateFile, '0')
  const fallbackContext = createContext()
  const fallbackAgent = { id: 'fallback-warm' }
  await apply(fallbackContext, config(fallbackStateFile, {
    warmIdleMs: -1,
    releaseOnTurnEnd: true
  }))
  await call(fallbackContext, 'mcp__lazy-fixture__activate', {}, fallbackAgent)
  fallbackContext.emit('agent/turn-stopping', { agent: fallbackAgent })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await call(fallbackContext, routerToolName, {
    query: 'fixture echo',
    serverName: 'lazy-fixture'
  }, fallbackAgent)
  assert.equal(await starts(fallbackStateFile), 1, 'invalid warm TTL falls back to five-minute reuse')
  fallbackContext.cleanup()

  const zeroStateFile = join(tempRoot, 'warm-zero-starts')
  await writeFile(zeroStateFile, '0')
  const zeroContext = createContext()
  const zeroAgent = { id: 'zero-warm' }
  await apply(zeroContext, config(zeroStateFile, {
    warmIdleMs: 0,
    releaseOnTurnEnd: true
  }))
  await call(zeroContext, 'mcp__lazy-fixture__activate', {}, zeroAgent)
  zeroContext.emit('agent/turn-stopping', { agent: zeroAgent })
  await call(zeroContext, routerToolName, {
    query: 'fixture echo',
    serverName: 'lazy-fixture'
  }, zeroAgent)
  assert.equal(await starts(zeroStateFile), 2, 'zero warm TTL preserves immediate-close behavior')
  zeroContext.cleanup()
}

async function warmReuseAndExpiry() {
  const stateFile = join(tempRoot, 'warm-starts')
  await writeFile(stateFile, '0')
  const context = createContext()
  const agent = { id: 'warm' }
  await apply(context, config(stateFile, {
    warmIdleMs: 120,
    releaseOnTurnEnd: true
  }))

  await call(context, 'mcp__lazy-fixture__activate', {}, agent)
  assert.equal(await starts(stateFile), 1)
  context.emit('agent/turn-stopping', { agent })
  await waitFor(() => !context.definitions.has('mcp__lazy-fixture__echo'), 'warm turn unloads schemas')

  const routed = await call(context, routerToolName, {
    query: 'fixture echo',
    serverName: 'lazy-fixture'
  }, agent)
  assert.match(routed.content[0].text, /lazy-fixture/)
  assert.equal(await starts(stateFile), 1)
  assert.equal((await call(context, 'mcp__lazy-fixture__echo', { text: 'warm-reuse' }, agent)).content[0].text, 'warm-reuse')

  context.emit('agent/turn-stopping', { agent })
  await new Promise((resolve) => setTimeout(resolve, 180))
  await call(context, 'mcp__lazy-fixture__activate', {}, agent)
  assert.equal(await starts(stateFile), 2)
  context.cleanup()
}

async function explicitDeactivateCancelsReconnect() {
  const stateFile = join(tempRoot, 'deactivate-reconnect-starts')
  await writeFile(stateFile, '0')
  const context = createContext()
  const agent = { id: 'deactivate-reconnect' }
  await apply(context, config(stateFile, {
    args: [fixture, stateFile, '0', '500'],
    autoActivate: true,
    reconnectAttempts: 3
  }))

  await waitFor(() => context.definitions.has('mcp__lazy-fixture__echo'), 'auto-activated fixture')
  await call(context, 'mcp__lazy-fixture__disconnect_once', {}, agent)
  await waitFor(async () => await starts(stateFile) === 2, 'reconnect process starts before explicit deactivate')
  await call(context, 'mcp__lazy-fixture__deactivate', {}, agent)
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(await starts(stateFile), 2)
  assert.deepEqual([...context.definitions.keys()].sort(), [
    'mcp__lazy-fixture__activate',
    'mcp__lazy-fixture__deactivate',
    routerToolName
  ])
  context.cleanup()
}

async function activationHonorsAbortSignal() {
  const stateFile = join(tempRoot, 'abort-starts')
  await writeFile(stateFile, '0')
  const context = createContext()
  const agent = { id: 'abort' }
  await apply(context, config(stateFile, {
    args: [fixture, stateFile, '0', '5000']
  }))

  const controller = new AbortController()
  const pending = call(context, 'mcp__lazy-fixture__activate', {}, agent, controller.signal)
  await waitFor(async () => await starts(stateFile) === 1, 'activation fixture starts')
  const abortedAt = Date.now()
  controller.abort(new Error('test abort'))
  const result = await pending
  assert.ok(Date.now() - abortedAt < 1000, 'activation should stop promptly after its execution signal aborts')
  assert.match(result.content[0].text, /失败/)
  assert.ok(!context.definitions.has('mcp__lazy-fixture__echo'))
  context.cleanup()
}

try {
  await unconfiguredInstanceIsNoOp()
  await fullLifecycle()
  configurationDefaults()
  await demandDisappearsDuringReconnect()
  await sharedRouterCleanupOrder()
  await invalidWarmIdleFallsBackWithoutChangingZero()
  await warmReuseAndExpiry()
  await explicitDeactivateCancelsReconnect()
  await activationHonorsAbortSignal()
  console.log('plugin lifecycle ok')
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
