# Automatic MCP Routing, Warm Lifecycle, and DSH Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release `@xiaoyilin/dsh-mcp-lazy` 0.4.0 with one shared search-and-activate router, five-minute connection warming while tool schemas remain unloaded, and a capability-probed DSH adapter tested against rc.6 and rc.7.

**Architecture:** `lib/dsh-adapter.js` contains every DSH-specific operation, `lib/tool-router.js` owns a shared router registry keyed by the adapter identity, and `lib/server-runtime.js` owns one MCP server's connection/catalog/publication state. `lib/index.js` remains the composition root that builds MCP transports and tool definitions, then wires those three modules together.

**Tech Stack:** Node.js 20/24 ESM, `node:test`, `@modelcontextprotocol/sdk`, `@deepseek-ai/schemastery`, DSH/Cordis host APIs, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-18-auto-routing-warm-compat-design.md`

## Global Constraints

- Existing stdio and streamable-http configurations remain valid.
- `warmIdleMs` defaults to exactly `300000`; `0` restores immediate close at turn end.
- `routingHints` defaults to an empty string array.
- Inactive servers expose no remote tool schemas; the only new permanent schema is one shared `mcp__router__search_and_activate` tool per DSH tool domain.
- Router ambiguity or zero score never activates a server.
- Catalog data remains memory-only and never includes command, args, env, headers, URL, or tool results.
- Exact native MCP tool schemas remain the invocation surface after activation.
- Configured instances on an unsupported DSH host log one capability error and return without throwing.
- Every shell command in this environment begins with `rtk`.
- Production edits use `apply_patch`; generated lockfile rewrites may use npm.

---

### Task 1: Add the DSH compatibility adapter

**Files:**
- Create: `lib/dsh-adapter.js`
- Create: `test/dsh-adapter.test.mjs`
- Modify: `lib/index.js:218-226`

**Interfaces:**
- Consumes: the raw Cordis/DSH `ctx` object passed to `apply(ctx, config)`.
- Produces: `createDshAdapter(ctx) -> { supported, reason?, identity?, registerTool?, on?, effect?, log? }`.
- `identity` is exactly `ctx.tools`; this makes all plugin instances sharing one DSH tool service share one router registry.

- [ ] **Step 1: Write adapter contract tests**

Create `test/dsh-adapter.test.mjs` with real fake host behavior:

```js
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
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run: `rtk node --test test/dsh-adapter.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/dsh-adapter.js`.

- [ ] **Step 3: Implement the stable adapter**

Create `lib/dsh-adapter.js`:

```js
const REQUIRED_CAPABILITIES = [
  ['ctx.tools.register', (ctx) => ctx?.tools?.register],
  ['ctx.on', (ctx) => ctx?.on],
  ['ctx.effect', (ctx) => ctx?.effect]
]

function createDshAdapter(ctx) {
  const missing = REQUIRED_CAPABILITIES
    .filter(([, read]) => typeof read(ctx) !== 'function')
    .map(([name]) => name)
  if (missing.length > 0) {
    const reason = `unsupported DSH host; missing capabilities: ${missing.join(', ')}`
    ctx?.logger?.error?.(`mcp-lazy: ${reason}`)
    return { supported: false, reason }
  }
  return {
    supported: true,
    identity: ctx.tools,
    registerTool: (definition) => ctx.tools.register(definition),
    on: (event, handler) => ctx.on(event, handler),
    effect: (factory, label) => ctx.effect(factory, label),
    log(level, message) {
      const logger = ctx.logger
      const method = typeof logger?.[level] === 'function' ? level : 'info'
      logger?.[method]?.(message)
    }
  }
}

export { createDshAdapter }
```

At the start of configured `apply`, create the adapter and return when unsupported:

```js
const adapter = createDshAdapter(ctx)
if (!adapter.supported) return
```

Do not replace the remaining direct `ctx` calls in this task; Task 4 performs that composition refactor after runtime and router interfaces exist.

- [ ] **Step 4: Run focused and full tests**

Run: `rtk node --test test/dsh-adapter.test.mjs`

Expected: 4 tests pass.

Run: `rtk npm test`

Expected: all existing tests plus the 4 adapter tests pass.

- [ ] **Step 5: Commit the adapter boundary**

```bash
rtk git add lib/dsh-adapter.js lib/index.js test/dsh-adapter.test.mjs
rtk git commit -m "refactor: isolate DSH host capabilities"
```

---

### Task 2: Add deterministic shared routing

**Files:**
- Create: `lib/tool-router.js`
- Create: `test/router.test.mjs`

**Interfaces:**
- Consumes: a supported adapter and entries shaped as `{ serverName, routingHints, getCatalog, activate }`.
- Produces: `registerRouterServer(adapter, entry) -> dispose`, `selectRoute(entries, { query, serverName })`, and the constant `ROUTER_TOOL_NAME`.
- `getCatalog()` returns an array of `{ name, description }` and never configuration or call data.
- `activate(agent, signal)` returns the existing human-readable activation result.

- [ ] **Step 1: Write selection behavior tests**

Create `test/router.test.mjs` with these literal cases:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { ROUTER_TOOL_NAME, registerRouterServer, selectRoute } from '../lib/tool-router.js'

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
```

- [ ] **Step 2: Run router tests and verify RED**

Run: `rtk node --test test/router.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/tool-router.js`.

- [ ] **Step 3: Implement scoring and shared registry**

Create `lib/tool-router.js` with the following public behavior:

```js
const ROUTER_TOOL_NAME = 'mcp__router__search_and_activate'
const registries = new WeakMap()

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
}

function searchableText(entry) {
  return [
    entry.serverName,
    ...(entry.routingHints ?? []),
    ...entry.getCatalog().flatMap((tool) => [tool.name, tool.description ?? ''])
  ].map(normalized)
}

function scoreEntry(query, entry) {
  const needle = normalized(query).trim()
  if (!needle) return 0
  const terms = needle.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
  return searchableText(entry).reduce((score, value) => {
    if (!value) return score
    let next = score + (value.includes(needle) ? 8 : 0)
    for (const term of terms) if (value.includes(term)) next += 1
    return next
  }, 0)
}

function selectRoute(entries, { query, serverName }) {
  const sorted = [...entries].sort((left, right) => left.serverName.localeCompare(right.serverName))
  if (serverName) return { entry: sorted.find((item) => item.serverName === serverName), candidates: [] }
  const prefix = normalized(query).match(/mcp__([a-z0-9_-]{1,32})__/i)?.[1]
  if (prefix) return { entry: sorted.find((item) => normalized(item.serverName) === prefix), candidates: [] }
  const ranked = sorted.map((entry) => ({ entry, score: scoreEntry(query, entry) })).sort((a, b) => b.score - a.score || a.entry.serverName.localeCompare(b.entry.serverName))
  const top = ranked[0]?.score ?? 0
  const candidates = ranked.filter((item) => item.score === top && top > 0).map((item) => item.entry)
  return { entry: candidates.length === 1 ? candidates[0] : undefined, candidates: candidates.slice(0, 5) }
}
```

Implement `registerRouterServer` so the first entry registers one tool, later entries reuse the registry, duplicate server names throw a descriptive error without changing the existing entry, and the final dispose unregisters the router. Its `execute` calls `selectRoute`, returns a candidate message without activation for zero/tie, or awaits the selected entry's `activate(exec.agent, exec.signal)`.

The registered definition uses the exact parameter Schema from the approved spec and a text output projector matching the existing control tools.

- [ ] **Step 4: Run focused and full tests**

Run: `rtk node --test test/router.test.mjs`

Expected: 4 tests pass.

Run: `rtk npm test`

Expected: complete suite passes.

- [ ] **Step 5: Commit shared routing**

```bash
rtk git add lib/tool-router.js test/router.test.mjs
rtk git commit -m "feat: add shared MCP search and activation router"
```

---

### Task 3: Extract the server runtime and implement warm idle

**Files:**
- Create: `lib/server-runtime.js`
- Modify: `lib/index.js:218-514`
- Modify: `test/fixtures/plugin-host-harness.mjs`
- Modify: `test/plugin-lifecycle.test.mjs`

**Interfaces:**
- Consumes: `{ adapter, config, label, reconnectAttempts, createConnectedClient, discoverDefinitions }`.
- Produces `createServerRuntime(options) -> { activate, deactivate, getCatalog, onTurnStopping, onAgentDisposed, dispose }`.
- `createConnectedClient(signal, callbacks)` returns a connected MCP client and installs the supplied `onClose` and `onToolsChanged` callbacks.
- `discoverDefinitions(client, signal)` returns `Map<publicName, { fingerprint, definition, summary }>` where summary is `{ name, description }`.

- [ ] **Step 1: Add warm lifecycle assertions to the real MCP host harness**

In `test/fixtures/plugin-host-harness.mjs`, add a `warmReuseAndExpiry()` scenario using the existing state-file fixture:

```js
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

  await call(context, 'mcp__lazy-fixture__activate', {}, agent)
  assert.equal(await starts(stateFile), 1)
  assert.equal((await call(context, 'mcp__lazy-fixture__echo', { text: 'warm-reuse' }, agent)).content[0].text, 'warm-reuse')

  context.emit('agent/turn-stopping', { agent })
  await new Promise((resolve) => setTimeout(resolve, 180))
  await call(context, 'mcp__lazy-fixture__activate', {}, agent)
  assert.equal(await starts(stateFile), 2)
  context.cleanup()
}
```

Invoke it before `activationHonorsAbortSignal()`. Extend `config()` with these literal defaults:

```js
warmIdleMs: 300000,
routingHints: []
```

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run: `rtk node --test test/plugin-lifecycle.test.mjs`

Expected: FAIL because the second activation increments `warm-starts` to `2` before the 120 ms TTL.

- [ ] **Step 3: Create the server runtime state machine**

Create `lib/server-runtime.js`. The runtime owns these variables and no DSH raw context:

```js
let client
let connectingClient
let catalog = new Map()
let registrations = new Map()
let activation = null
let activationController
let reconnectTimer
let warmTimer
let users = new Set()
let reconnectRemaining = reconnectAttempts
let disposed = false
```

Implement these invariants directly in named helpers:

```js
function unpublishTools() {
  const count = registrations.size
  for (const entry of registrations.values()) {
    try { entry.dispose() } catch (error) { adapter.log('warn', `${label}: tool disposal failed: ${String(error)}`) }
  }
  registrations = new Map()
  return count
}

function publishCatalog() {
  registrations = reconcileRegistrations(
    registrations,
    catalog,
    (definition) => adapter.registerTool(definition)
  )
}

function beginWarmIdle(reason) {
  const count = unpublishTools()
  adapter.log('info', `${label}: ${reason}，${count} 个工具已卸载，连接保温 ${config.warmIdleMs}ms`)
  if (config.warmIdleMs === 0) return hardClose()
  clearWarmTimer()
  warmTimer = setTimeout(() => { warmTimer = undefined; void hardClose() }, config.warmIdleMs)
  warmTimer.unref?.()
}
```

`activate` must execute in this order:

1. Add the user and cancel `warmTimer`.
2. If `client` exists and `registrations.size === 0`, call `publishCatalog()` and return a warm-reactivation message.
3. If `client` and registrations both exist, return the current already-active message.
4. Otherwise connect, discover into a temporary map, assign catalog only after successful discovery, publish it, and return the cold activation message.

On tools/list change, discover a complete temporary map. Assign it to catalog only after validation. Reconcile registrations only when `users.size > 0`, `autoActivate` is true, or `releaseOnTurnEnd` is false.

On turn stopping, remove that agent. When no users remain and `releaseOnTurnEnd` is true, call `beginWarmIdle`. On an unexpected close, clear client and registrations; schedule bounded reconnect only when users remain or autoActivate is true. Explicit deactivate and dispose call `hardClose`, cancel both timers, abort activation, clear users, and never wait for the warm TTL.

Export only `createServerRuntime`.

- [ ] **Step 4: Recompose index.js around the runtime**

Keep transport construction, output projection, executor creation, name normalization, and MCP schema validation in `lib/index.js`. Change `discoverDefinitions` to include a summary:

```js
definitions.set(publicName, {
  fingerprint: fingerprintTool(tool),
  summary: { name: publicName, description: tool.description ?? '' },
  definition: {
    name: publicName,
    description: tool.description ?? '',
    parameters: tool.inputSchema,
    output: createOutput(tool.name, supportedOutputSchema(tool.outputSchema)),
    execute: createExecutor(client, tool.name, tool.execution?.taskSupport === 'required', config.toolCallTimeoutMs, runtime.addUser, runtime.markSuccessfulUse)
  }
})
```

Construct `createServerRuntime` after the adapter, register the existing activate/deactivate definitions with `adapter.registerTool`, wire `adapter.on` to `runtime.onTurnStopping` and `runtime.onAgentDisposed`, and call `runtime.dispose` from `adapter.effect` cleanup.

Because executors must report use before runtime exists, expose `addUser(agent)` and `markSuccessfulUse(agent)` on the runtime return object; both are synchronous and covered by the existing reconnect lifecycle scenario.

- [ ] **Step 5: Verify warm, reconnect, abort, and full regression behavior**

Run: `rtk node --test test/plugin-lifecycle.test.mjs`

Expected: lifecycle test passes, including start count `1` during warm reuse and `2` after expiry.

Run: `rtk npm test`

Expected: complete suite passes with no unhandled rejection or timer warning.

- [ ] **Step 6: Commit the runtime extraction**

```bash
rtk git add lib/server-runtime.js lib/index.js test/fixtures/plugin-host-harness.mjs test/plugin-lifecycle.test.mjs
rtk git commit -m "feat: keep idle MCP connections warm without publishing tools"
```

---

### Task 4: Wire the router, configuration, release metadata, and documentation

**Files:**
- Modify: `lib/index.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `test/package-metadata.test.mjs`
- Modify: `test/fixtures/plugin-host-harness.mjs`

**Interfaces:**
- Consumes: `registerRouterServer(adapter, entry)` from Task 2 and runtime methods from Task 3.
- Produces: one shared router registration plus backward-compatible per-server activate/deactivate controls.

- [ ] **Step 1: Write failing composition and version assertions**

Extend `test/package-metadata.test.mjs`:

```js
assert.equal(pkg.version, '0.4.0')
```

In the host harness, after applying the first configured server, assert the router exists:

```js
assert.ok(context.definitions.has('mcp__router__search_and_activate'))
```

In `warmReuseAndExpiry`, call the router instead of the second explicit activation:

```js
const routed = await call(context, 'mcp__router__search_and_activate', {
  query: 'fixture echo',
  serverName: 'lazy-fixture'
}, agent)
assert.match(routed.content[0].text, /lazy-fixture/)
assert.equal(await starts(stateFile), 1)
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `rtk node --test test/package-metadata.test.mjs test/plugin-lifecycle.test.mjs`

Expected: FAIL because version is `0.3.0` and the router is not wired by `apply`.

- [ ] **Step 3: Extend the config Schema and wire router lifecycle**

Add to both transport variants in `ServerConfig`:

```js
warmIdleMs: z.number().default(300000),
routingHints: z.array(String).default([])
```

Normalize `warmIdleMs` with a non-negative integer fallback of `300000` before passing config to the runtime.

After creating the runtime, register this entry:

```js
const unregisterRouter = registerRouterServer(adapter, {
  serverName: config.serverName,
  routingHints: config.routingHints,
  getCatalog: runtime.getCatalog,
  activate: (agent, signal) => runtime.activate(agent, false, signal)
})
```

Call `unregisterRouter()` exactly once inside the adapter effect cleanup before `runtime.dispose()`. Keep server-specific activate and deactivate controls unchanged.

- [ ] **Step 4: Bump version and document behavior**

Run: `rtk npm version 0.4.0 --no-git-tag-version`

Update README configuration examples and table with `warmIdleMs` and `routingHints`. Rewrite the lifecycle statements to say that turn end unloads tool schemas immediately while the default connection remains warm for 5 minutes. Document `warmIdleMs: 0` as exact 0.3.x close behavior and explain that the shared router refuses ambiguous matches.

- [ ] **Step 5: Run metadata, lifecycle, and complete tests**

Run: `rtk node --test test/package-metadata.test.mjs test/plugin-lifecycle.test.mjs test/router.test.mjs`

Expected: focused tests pass.

Run: `rtk npm test`

Expected: complete suite passes.

- [ ] **Step 6: Commit the 0.4.0 composition**

```bash
rtk git add lib/index.js package.json package-lock.json README.md test/package-metadata.test.mjs test/fixtures/plugin-host-harness.mjs
rtk git commit -m "feat: route and warm lazy MCP servers in version 0.4.0"
```

---

### Task 5: Add Node and DSH compatibility matrices

**Files:**
- Create: `test/dsh-version-compat.test.mjs`
- Modify: `.github/workflows/test.yml`
- Modify: `test/ci-workflow.test.mjs`

**Interfaces:**
- Consumes: the `DSH_COMPAT_VERSION` environment variable and host packages installed from `@deepseek-ai/dsh`.
- Produces: a smoke test proving the plugin imports with host-owned peers and safely applies both unconfigured and configured instances.

- [ ] **Step 1: Write the DSH-version smoke test and CI structure assertion**

Create `test/dsh-version-compat.test.mjs`:

```js
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { apply } from '../lib/index.js'

const require = createRequire(import.meta.url)

test('plugin imports host-owned peers for the requested DSH version', async (t) => {
  const expected = process.env.DSH_COMPAT_VERSION
  if (!expected) return t.skip('DSH_COMPAT_VERSION is only set by compatibility CI')
  const actual = require('@deepseek-ai/dsh/package.json').version
  assert.equal(actual, expected)
  await assert.doesNotReject(() => apply({}, undefined))

  const definitions = new Map()
  const cleanups = []
  const context = {
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    effect(factory) { cleanups.push(factory()) }
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
  assert.ok(definitions.has('mcp__router__search_and_activate'))
  for (const cleanup of cleanups.reverse()) cleanup?.()
})
```

Extend `test/ci-workflow.test.mjs` to parse `.github/workflows/test.yml` as text and assert the literal matrix values `20`, `24`, `0.1.0-rc.6`, and `0.1.0-rc.7` are present. This test protects the repository's promised compatibility policy, not GitHub Actions internals.

- [ ] **Step 2: Run the CI workflow test and verify RED**

Run: `rtk node --test test/ci-workflow.test.mjs test/dsh-version-compat.test.mjs`

Expected: CI workflow assertion fails because the matrices do not exist; the version smoke test skips locally.

- [ ] **Step 3: Add the matrices**

Change the existing test job to:

```yaml
strategy:
  matrix:
    node-version: [20, 24]
```

Use `${{ matrix.node-version }}` in setup-node.

Add a `dsh-compat` job with:

```yaml
strategy:
  matrix:
    dsh-version: [0.1.0-rc.6, 0.1.0-rc.7]
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 20
      cache: npm
  - run: npm ci --legacy-peer-deps --ignore-scripts
  - run: npm install --no-save --legacy-peer-deps --ignore-scripts @deepseek-ai/dsh@${{ matrix.dsh-version }}
  - run: node --test test/dsh-version-compat.test.mjs
    env:
      DSH_COMPAT_VERSION: ${{ matrix.dsh-version }}
```

- [ ] **Step 4: Run local regression and both real package smoke tests**

Run: `rtk npm test`

Expected: complete suite passes and the compatibility test skips once.

For each version, use a temporary directory so the repository lockfile remains unchanged:

```bash
rtk zsh -lc 'tmp=$(mktemp -d); trap '\''[[ -n "$tmp" && "$tmp" == /tmp/* ]] && rm -rf -- "$tmp"'\'' EXIT; cp package.json package-lock.json "$tmp/"; cp -R lib test "$tmp/"; cd "$tmp"; npm ci --legacy-peer-deps --ignore-scripts; npm install --no-save --legacy-peer-deps --ignore-scripts @deepseek-ai/dsh@0.1.0-rc.6; DSH_COMPAT_VERSION=0.1.0-rc.6 node --test test/dsh-version-compat.test.mjs'
rtk zsh -lc 'tmp=$(mktemp -d); trap '\''[[ -n "$tmp" && "$tmp" == /tmp/* ]] && rm -rf -- "$tmp"'\'' EXIT; cp package.json package-lock.json "$tmp/"; cp -R lib test "$tmp/"; cd "$tmp"; npm ci --legacy-peer-deps --ignore-scripts; npm install --no-save --legacy-peer-deps --ignore-scripts @deepseek-ai/dsh@0.1.0-rc.7; DSH_COMPAT_VERSION=0.1.0-rc.7 node --test test/dsh-version-compat.test.mjs'
```

Expected: each command reports one passing test and zero failures.

- [ ] **Step 5: Commit compatibility automation**

```bash
rtk git add .github/workflows/test.yml test/ci-workflow.test.mjs test/dsh-version-compat.test.mjs
rtk git commit -m "ci: verify Node and DSH compatibility matrices"
```

---

### Task 6: Deploy locally and run full DSH/Chrome acceptance

**Files:**
- Modify mechanically: `~/.dsh/profiles/web/package.json` and `pnpm-lock.yaml` by updating the GitHub dependency after the repository commit is pushed.
- Temporarily modify and then restore: `~/.dsh/cordis.patch.yml`.
- No repository source changes unless acceptance exposes a bug; any bug starts a new failing automated test before its fix.

**Interfaces:**
- Consumes: the published GitHub commit and the local DSH launchd service `ai.deepseek.dsh.web`.
- Produces: evidence for router activation, warm reuse, cold expiry, explicit deactivate, environment restoration, and browser health.

- [ ] **Step 1: Run final repository verification before push**

```bash
rtk npm test
rtk git diff --check
rtk git status --short --branch
```

Expected: all tests pass, diff check is empty, and only intended commits are ahead of `origin/main`.

- [ ] **Step 2: Push and update the local profile**

```bash
rtk git push origin main
rtk pnpm update @xiaoyilin/dsh-mcp-lazy
```

Run the second command in `~/.dsh/profiles/web`. Verify installed version with:

```bash
rtk node -p 'require("./node_modules/@xiaoyilin/dsh-mcp-lazy/package.json").version'
```

Expected: `0.4.0`.

- [ ] **Step 3: Add a temporary short-TTL fixture and restart DSH**

Append one temporary plugin entry using the repository's `test/fixtures/dynamic-mcp-server.mjs`, `serverName: chrome-fixture`, `warmIdleMs: 1500`, `routingHints: ['Chrome 全量测试', 'echo fixture']`, `releaseOnTurnEnd: true`, and a unique `/tmp` start-count file initialized to `0`.

Restart with:

```bash
rtk launchctl kickstart -k gui/501/ai.deepseek.dsh.web
```

Poll `POST http://127.0.0.1:3080/api/llm.models` until HTTP 200 instead of sleeping a fixed duration.

- [ ] **Step 4: Execute the real Chrome flow**

In a new DSH session using DeepSeek-V4-Pro Max:

1. Ask the model to find a tool for `Chrome 全量测试 echo fixture` without naming any activate tool.
2. Verify it calls `mcp__router__search_and_activate`, selects `chrome-fixture`, and then calls the native echo tool.
3. End the turn and verify the dynamic tools leave the next turn's directory while the start-count file remains `1`.
4. Within 1500 ms, route and echo again; verify the start count is still `1`.
5. End the turn, wait until the short TTL expires, route and echo again; verify the start count becomes `2`.
6. Call `mcp__chrome-fixture__deactivate`; verify the reported unloaded count and absence of dynamic tools.
7. Inspect Chrome console messages and require zero JavaScript error/warn entries.

- [ ] **Step 5: Restore the formal environment and re-verify**

Remove the temporary fixture block and its `/tmp` state file, restart the service, and verify:

```bash
rtk rg -c "^      name: '@xiaoyilin/dsh-mcp-lazy'$" /Users/xiaoyilin/.dsh/cordis.patch.yml
rtk curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
rtk npm test
rtk git status --short --branch
```

Expected: 8 configured lazy MCP entries, HTTP 200, complete test pass, and a clean branch synchronized with `origin/main`.

Reload the formal Chrome page after restoration and verify DeepSeek-V4-Pro Max, connected/online status, and no console error/warn messages.
