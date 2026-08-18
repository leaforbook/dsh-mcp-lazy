import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../../lib/index.js'

const fixture = fileURLToPath(new URL('./dynamic-mcp-server.mjs', import.meta.url))
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-mcp-lazy-host-'))

function createContext() {
  const definitions = new Map()
  const handlers = new Map()
  const cleanups = []
  const logs = []
  return {
    definitions,
    logs,
    tools: {
      register(definition) {
        if (definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
        definitions.set(definition.name, definition)
        let active = true
        return () => {
          if (!active) return
          active = false
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

async function fullLifecycle() {
  const stateFile = join(tempRoot, 'full-starts')
  await writeFile(stateFile, '0')
  const context = createContext()
  const agent = { id: 'full' }
  await apply(context, config(stateFile, {
    args: [fixture, stateFile, '2', '0'],
    reconnectAttempts: 3
  }))

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
    'mcp__lazy-fixture__deactivate'
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
  await fullLifecycle()
  await demandDisappearsDuringReconnect()
  await activationHonorsAbortSignal()
  console.log('plugin lifecycle ok')
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
