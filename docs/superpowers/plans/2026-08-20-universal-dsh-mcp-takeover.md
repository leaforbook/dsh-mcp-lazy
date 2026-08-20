# Universal DSH MCP Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让安装后的插件自动隐藏并按需披露所有通过兼容性准入的 DSH MCP Schema，同时让不兼容或不确定的 MCP 完全保持 DSH 原始体验。

**Architecture:** 新增纯函数 MCP catalog 和每个 DSH tool-service 一份的 universal manager。Manager 使用 DSH 公共 `tools.schemas/get/restrict` 与 `tools/change`、agent 生命周期事件维护会话级 deny mask；现有共享 router 同时合并显式 lazy server 与兼容 passive server。任何准入、路由或 restriction 失败都 fail-open，不改配置、不替换原执行器。

**Tech Stack:** Node.js 20+ ESM、`node:test`、DeepSeek Harness ToolRuntime/Cordis 公共 API、Schemastery、MCP SDK。

**Spec:** `docs/superpowers/specs/2026-08-20-universal-dsh-mcp-takeover-design.md`

## Global Constraints

- 只管理满足 DSH `mcp__<serverName>__<toolName>` 公共命名契约且通过原子兼容性准入的全局工具。
- `hidden(server, agent) => classified(server) && routable(server) && revealable(server, agent)` 必须始终成立。
- 不兼容、冲突、不确定或运行时出错的 MCP 必须 fail-open；宁可失去 Token 节省，也不能失去工具可用性。
- 不读取或重写 `cordis.yml`、`cordis.patch.yml`、URL、headers、env 或用户凭据。
- Passive MCP 的原始 `ToolDefinition`、执行链、rich output、附件、权限和审计不可被包装或替换。
- 显式 lazy server 的连接、重连、轮末卸载和 warm-idle 行为保持兼容。
- Node 20/24 与 DSH `0.1.0-rc.6`/`0.1.0-rc.7`/`0.1.0-rc.8` 兼容矩阵保持通过。

---

## File Structure

- Create `lib/mcp-catalog.js`: 解析公共 MCP 名称、验证全局 schema/definition 对应关系、生成原子 server catalog 和稳定签名。
- Create `lib/universal-manager.js`: tool-service 级共享 manager、agent restriction、catalog reconcile、passive router source、fail-open 清理。
- Create `test/mcp-catalog.test.mjs`: catalog 准入与 passthrough 纯函数测试。
- Create `test/universal-manager.test.mjs`: agent 隔离、动态工具、路由披露、fail-open 和 disposal 集成测试。
- Modify `lib/dsh-adapter.js`: 保留现有 server adapter，增加 capability-gated universal adapter。
- Modify `lib/tool-router.js`: 支持一份 visibility controller 和 passive entries，同时保持 managed entry 生命周期语义。
- Modify `lib/index.js`: `mode: manager` 配置分派并安装 universal manager。
- Modify `cordis.patch.yml`: 默认启用唯一 `mcp-lazy-manager` bundle entry。
- Modify `test/dsh-adapter.test.mjs`: universal capability contract 与缺失能力降级测试。
- Modify `test/router.test.mjs`: passive-only router、managed 优先、披露失败和 controller disposal 测试。
- Create `test/fixtures/passive-tool-provider.mjs`: 无凭据的兼容/不兼容 DSH 工具提供方，供 host 与浏览器验收复用。
- Modify `test/fixtures/plugin-host-harness.mjs`: 补齐真实 schema/get/restrict scope，以覆盖 manager 与 managed lazy 共存。
- Modify `test/plugin-lifecycle.test.mjs`: real MCP fixture 的 universal 生命周期断言。
- Modify `test/dsh-version-compat.test.mjs`: manager 配置在 rc.6/rc.7/rc.8 host graph 的真实导入/清理测试。
- Modify `test/readme-install.test.mjs`: 默认 manager bundle、安装说明与 fail-open 文档契约测试。
- Modify `README.md`: 自动接管边界、兼容性准入、passive/managed 差异、关闭方式和验证方法。
- Modify `package.json`, `package-lock.json`: minor version `0.5.0` 与发布元数据同步。

---

### Task 1: Pure MCP Catalog and Compatibility Admission

**Files:**
- Create: `lib/mcp-catalog.js`
- Create: `test/mcp-catalog.test.mjs`

**Interfaces:**
- Produces: `parseMcpPublicName(name): { serverName: string, toolName: string } | undefined`
- Produces: `buildMcpCatalog({ schemas, getDefinition, routerName }): { signature: string, servers: Map<string, CatalogServer>, passthrough: Set<string> }`
- Produces: `stableSchemaFingerprint(schema): string`, recursively sorting JSON object keys so descriptions and parameters change the catalog signature deterministically.
- Produces: `CatalogServer = { serverName, toolNames, getCatalog() }`, where `getCatalog()` returns `{ name, description }[]`.
- Consumes: DSH global `ToolSchema[]` and `ctx.tools.get(name)` results only.

- [ ] **Step 1: Write failing parser and admission tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMcpCatalog, parseMcpPublicName } from '../lib/mcp-catalog.js'

test('parses only exact DSH MCP public names', () => {
  assert.deepEqual(parseMcpPublicName('mcp__context7__query_docs'), {
    serverName: 'context7',
    toolName: 'query_docs'
  })
  for (const name of ['read_file', 'mcp_context7_query', 'mcp____query', 'mcp__bad name__query']) {
    assert.equal(parseMcpPublicName(name), undefined)
  }
})

test('admits resolved namespaces and leaves unresolved or router names passthrough', () => {
  const definitions = new Map([
    ['mcp__alpha__one', { name: 'mcp__alpha__one' }],
    ['mcp__router__search_and_activate', { name: 'mcp__router__search_and_activate' }]
  ])
  const catalog = buildMcpCatalog({
    schemas: [
      { name: 'mcp__alpha__one', description: 'alpha one' },
      { name: 'mcp__broken__ghost', description: 'missing definition' },
      { name: 'mcp__router__search_and_activate', description: 'router' },
      { name: 'ordinary', description: 'ordinary tool' }
    ],
    getDefinition: name => definitions.get(name),
    routerName: 'mcp__router__search_and_activate'
  })
  assert.deepEqual([...catalog.servers.keys()], ['alpha'])
  assert.deepEqual([...catalog.passthrough], ['mcp__broken__ghost'])
  assert.deepEqual(catalog.servers.get('alpha').toolNames, ['mcp__alpha__one'])
})
```

- [ ] **Step 2: Run the catalog test and verify RED**

Run: `rtk node --test test/mcp-catalog.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/mcp-catalog.js`.

- [ ] **Step 3: Implement the minimal catalog**

```js
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

function parseMcpPublicName(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return undefined
  const boundary = name.indexOf('__', 5)
  if (boundary < 0) return undefined
  const serverName = name.slice(5, boundary)
  const toolName = name.slice(boundary + 2)
  if (!SERVER_NAME.test(serverName) || toolName.length === 0) return undefined
  return { serverName, toolName }
}
```

Implement `buildMcpCatalog` by sorting schemas by exact name, excluding `routerName`, verifying `getDefinition(schema.name)?.name === schema.name`, grouping only fully resolved names, marking unresolved matching names passthrough, and deriving `signature` from each admitted schema's exact name plus `stableSchemaFingerprint({ description, parameters })` and the sorted passthrough names. Do not retain the returned definitions.

- [ ] **Step 4: Add RED tests for case, order, mutation, and atomic passthrough**

Add tests proving:

```js
assert.notEqual(catalog.servers.get('Foo'), catalog.servers.get('foo'))
assert.equal(buildFrom(['b', 'a']).signature, buildFrom(['a', 'b']).signature)
assert.notEqual(buildWithDescription('before').signature, buildWithDescription('after').signature)
assert.notEqual(buildWithParameters({ type: 'object' }).signature, buildWithParameters({ type: 'string' }).signature)
assert.deepEqual(catalog.servers.get('alpha').getCatalog(), [
  { name: 'mcp__alpha__one', description: 'alpha one' }
])
```

Add one namespace with two schemas where one definition is unresolved; assert the entire namespace is absent from `servers` and both names are present in `passthrough`.

- [ ] **Step 5: Run the catalog test and verify GREEN**

Run: `rtk node --test test/mcp-catalog.test.mjs`

Expected: all catalog tests pass with zero warnings.

- [ ] **Step 6: Commit the catalog cycle**

```bash
rtk git add lib/mcp-catalog.js test/mcp-catalog.test.mjs
rtk git commit -m "feat: classify compatible DSH MCP tools"
```

---

### Task 2: Capability-gated Universal DSH Adapter

**Files:**
- Modify: `lib/dsh-adapter.js`
- Modify: `test/dsh-adapter.test.mjs`

**Interfaces:**
- Consumes: existing `createDshAdapter(ctx)`.
- Produces: `createUniversalDshAdapter(ctx): { supported, reason?, identity, registerTool, on, effect, log, listToolSchemas, getTool, restrictAgentTools }`.
- `restrictAgentTools(agent, deny)` returns the exact DSH restriction disposer and requires `agent.ctx.tools.restrict`.

- [ ] **Step 1: Write failing universal adapter tests**

```js
test('universal adapter projects global schemas and scoped restrictions', () => {
  const ctx = supportedUniversalContext()
  const adapter = createUniversalDshAdapter(ctx)
  const agent = ctx.createAgent('a')
  assert.equal(adapter.supported, true)
  assert.deepEqual(adapter.listToolSchemas().map(schema => schema.name), ['ordinary'])
  assert.equal(adapter.getTool('ordinary').name, 'ordinary')
  const lift = adapter.restrictAgentTools(agent, ['mcp__alpha__one'])
  assert.deepEqual(agent.restrictions, [['mcp__alpha__one']])
  lift()
  assert.deepEqual(agent.restrictions, [])
})
```

Add a table test removing `tools.schemas`, `tools.get`, or the agent's scoped `tools.restrict`; assert `supported === false` for host-global missing capabilities and assert a scoped restriction failure is returned to the manager rather than mutating the base server adapter.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `rtk node --test test/dsh-adapter.test.mjs`

Expected: FAIL because `createUniversalDshAdapter` is not exported.

- [ ] **Step 3: Implement the universal adapter without changing base support**

Keep `createDshAdapter` requirements exactly `tools.register`, `ctx.on`, and `ctx.effect`. Add universal checks separately so an rc host missing progressive disclosure still supports explicit lazy servers.

```js
function createUniversalDshAdapter(ctx) {
  const base = createDshAdapter(ctx)
  if (!base.supported) return base
  const missing = [
    ['ctx.tools.schemas', ctx?.tools?.schemas],
    ['ctx.tools.get', ctx?.tools?.get]
  ].filter(([, value]) => typeof value !== 'function').map(([name]) => name)
  if (missing.length) return { ...base, supported: false, reason: `unsupported universal manager; missing capabilities: ${missing.join(', ')}` }
  return {
    ...base,
    listToolSchemas: () => ctx.tools.schemas(),
    getTool: name => ctx.tools.get(name),
    restrictAgentTools(agent, deny) {
      if (typeof agent?.ctx?.tools?.restrict !== 'function') {
        throw new Error('agent scoped tools.restrict is unavailable')
      }
      return agent.ctx.tools.restrict({ deny })
    }
  }
}
```

- [ ] **Step 4: Run adapter tests and verify GREEN**

Run: `rtk node --test test/dsh-adapter.test.mjs`

Expected: all adapter tests pass; existing opaque identity tests remain unchanged.

- [ ] **Step 5: Commit the adapter cycle**

```bash
rtk git add lib/dsh-adapter.js test/dsh-adapter.test.mjs
rtk git commit -m "feat: expose safe progressive disclosure adapter"
```

---

### Task 3: Shared Router Passive-source Support

**Files:**
- Modify: `lib/tool-router.js`
- Modify: `test/router.test.mjs`

**Interfaces:**
- Consumes: existing `registerRouterServer(adapter, managedEntry)`.
- Produces: `registerRouterVisibility(adapter, controller): () => void`.
- Controller contract: `{ getEntries(): RouterEntry[], reveal(agent, serverName): Promise<string> | string }`.
- Router entry contract remains `{ serverName, routingHints, getCatalog, activate? }`.

- [ ] **Step 1: Write failing passive-only router test**

```js
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
```

- [ ] **Step 2: Run router tests and verify RED**

Run: `rtk node --test test/router.test.mjs`

Expected: FAIL because `registerRouterVisibility` is not exported.

- [ ] **Step 3: Refactor the router registry to merge managed and passive entries**

Add one `visibility` slot per service registry. The router is published while either `entries.size > 0` or `visibility` exists. On execution:

```js
const managed = [...registry.entries.values()].map(record => record.entry)
const managedNames = new Set(managed.map(entry => entry.serverName))
const passive = (registry.visibility?.controller.getEntries() ?? [])
  .filter(entry => !managedNames.has(entry.serverName))
const route = selectRoute([...managed, ...passive], args)
```

When selected entry is managed, await its current `activate` first and then call `visibility.controller.reveal` when present. When selected entry is passive, call only `reveal`. Publish ownership still uses a live managed adapter when possible and otherwise the visibility adapter.

- [ ] **Step 4: Add RED tests for managed precedence and fail-open propagation**

Add tests proving:

- a managed and passive entry named `same` calls managed `activate` and then `reveal` exactly once;
- a passive `reveal` rejection is returned as a rejected router execution, not reported as success;
- disposing the visibility controller leaves managed router entries alive;
- disposing the last managed entry leaves a passive-only router alive;
- duplicate visibility controllers on one service are rejected without losing the first controller.

- [ ] **Step 5: Run router tests and verify GREEN**

Run: `rtk node --test test/router.test.mjs`

Expected: all router tests pass, including native router ownership rollback cases.

- [ ] **Step 6: Commit the router cycle**

```bash
rtk git add lib/tool-router.js test/router.test.mjs
rtk git commit -m "feat: route compatible passive MCP servers"
```

---

### Task 4: Universal Manager, Per-agent Isolation, and Fail-open Semantics

**Files:**
- Create: `lib/universal-manager.js`
- Create: `test/universal-manager.test.mjs`

**Interfaces:**
- Consumes: `buildMcpCatalog`, `registerRouterVisibility`, and the universal adapter.
- Produces: `installUniversalManager(adapter): () => void`.
- Internal controller methods: `reconcile()`, `onAgentCreated({ agent })`, `onTurnStopping({ agent })`, `onAgentDisposed({ agent })`, `reveal(agent, serverName)`.

- [ ] **Step 1: Write a failing cold-surface and selective-disclosure test**

Create a fake ToolRuntime that implements global `register/schemas/get`, emits synchronous `tools/change`, and gives each fake agent a scoped `restrict({ deny })` disposer. Assert:

```js
const disposeManager = installUniversalManager(createUniversalDshAdapter(host.ctx))
host.register(eagerTool('mcp__alpha__echo', 'echo alpha'))
host.register(eagerTool('mcp__beta__search', 'search beta'))
const first = host.createAgent('first')
const second = host.createAgent('second')
host.emit('agent/created', { agent: first })
host.emit('agent/created', { agent: second })

assert.deepEqual(host.visibleNames(first), [ROUTER_TOOL_NAME])
assert.deepEqual(host.visibleNames(second), [ROUTER_TOOL_NAME])
await host.call(first, ROUTER_TOOL_NAME, { query: 'echo alpha' })
assert.deepEqual(host.visibleNames(first), [ROUTER_TOOL_NAME, 'mcp__alpha__echo'])
assert.deepEqual(host.visibleNames(second), [ROUTER_TOOL_NAME])
```

- [ ] **Step 2: Run manager tests and verify RED**

Run: `rtk node --test test/universal-manager.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/universal-manager.js`.

- [ ] **Step 3: Implement shared manager ownership and catalog reconciliation**

Use `WeakMap<adapter.identity, ManagerRecord>`. The first owner registers router visibility and four listeners: `tools/change`, `agent/created`, `agent/turn-stopping`, `agent/disposed`. Later owners increment a count. The last disposer lifts every agent restriction, removes listeners in reverse order, disposes router visibility, and deletes the WeakMap entry.

Each agent record is:

```js
{ agent, selectedServer: undefined, restriction: undefined, bypassUntilTurnEnd: false }
```

`replaceRestriction(record)` computes deny names only from admitted servers other than `selectedServer`. With an empty deny list it lifts the previous restriction and installs none. It installs the new DSH restriction before disposing the old one; if installation fails it disposes the old restriction, sets `bypassUntilTurnEnd`, and leaves the agent unrestricted.

- [ ] **Step 4: Add failing tests for lifecycle and dynamic changes**

Add separate tests proving:

- a second route replaces, rather than accumulates, the first visible server;
- `agent/turn-stopping` hides all admitted MCP tools again;
- `agent/disposed` lifts and removes the restriction exactly once;
- a server registered after agent creation is hidden synchronously;
- a removed selected server clears selection;
- a tool-list update replaces the catalog without duplicate router registration;
- two manager owners share one router/listener set and final cleanup restores all tools.

- [ ] **Step 5: Add failing tests for nonstandard passthrough and every fail-open path**

Add separate tests proving:

- `mcp_bad_name`, `mcp__bad name__tool`, an unresolved definition, and a native router collision remain visible;
- an atomic server snapshot with one unresolved tool leaves every tool in that namespace visible;
- missing agent `tools.restrict` leaves the agent surface unchanged and logs once;
- a thrown restriction replacement lifts the previous manager restriction for that agent;
- passive disclosure failure leaves the agent unrestricted for the rest of the turn;
- a later turn boundary permits a new admission attempt;
- manager cleanup still lifts restrictions when one listener disposer throws, and reports an `AggregateError` after all cleanup attempts.

- [ ] **Step 6: Implement reveal and fail-open until every manager test is GREEN**

`reveal(agent, serverName)` must verify the server remains admitted and routable, set `selectedServer`, and replace the restriction. If any check or replacement fails, call `failOpen(record, error)`, which lifts the restriction, sets `bypassUntilTurnEnd`, logs without schemas or configuration, and rethrows so the router cannot claim success.

- [ ] **Step 7: Run focused catalog, router, adapter, and manager tests**

Run:

```bash
rtk node --test test/mcp-catalog.test.mjs test/dsh-adapter.test.mjs test/router.test.mjs test/universal-manager.test.mjs
```

Expected: all focused tests pass with zero unhandled rejections or warnings.

- [ ] **Step 8: Commit the manager cycle**

```bash
rtk git add lib/universal-manager.js test/universal-manager.test.mjs
rtk git commit -m "feat: isolate MCP disclosure per DSH agent"
```

---

### Task 5: Plugin Config Dispatch and Default Manager Bundle

**Files:**
- Modify: `lib/index.js`
- Modify: `cordis.patch.yml`
- Create: `test/fixtures/passive-tool-provider.mjs`
- Modify: `test/fixtures/plugin-host-harness.mjs`
- Modify: `test/plugin-lifecycle.test.mjs`

**Interfaces:**
- Produces config variant: `{ mode: 'manager' }`.
- Existing stdio and streamable-http server variants remain unchanged.
- `apply(ctx, undefined)` remains a no-op.

- [ ] **Step 1: Write failing Config and bundle tests**

Add assertions:

```js
assert.deepEqual(Config({ mode: 'manager' }), { mode: 'manager' })
await assert.doesNotReject(() => apply(universalContext, { mode: 'manager' }))
```

Update the bundle test to expect exactly one enabled entry with id `mcp-lazy-manager`, package name `@yilinxiao/dsh-mcp-lazy`, and config `{ mode: 'manager' }`.

- [ ] **Step 2: Run lifecycle/readme tests and verify RED**

Run:

```bash
rtk node --test test/plugin-lifecycle.test.mjs test/readme-install.test.mjs
```

Expected: FAIL because `mode: manager` is rejected and the current bundle is disabled.

- [ ] **Step 3: Add manager Config dispatch and enabled bundle entry**

Define:

```js
const ManagerConfig = z.object({ mode: z.const('manager') })
const Config = z.union([ManagerConfig, ServerConfig])
```

At the start of `apply`, keep `config === undefined` as no-op. For `config.mode === 'manager'`, build a universal adapter; when unsupported log one compatibility error and return without restrictions, otherwise register `installUniversalManager(adapter)` through `adapter.effect(..., 'mcp-lazy.manager')` and return before transport setup.

Replace `cordis.patch.yml` with the enabled manager entry from the design spec.

- [ ] **Step 4: Extend the real host fixture with DSH-like visibility semantics**

The fixture ToolRuntime must keep global definitions, implement `schemas(scope?)`, `get(name, scope?)`, and agent-scoped `restrict({ deny })`. Its `register` and restriction changes emit `tools/change`. Create two agents with independent `ctx.tools` scoped facades.

Create `passive-tool-provider.mjs` with one switchable provider whose original executors remain directly observable:

```js
const output = {
  schema: {
    type: 'object',
    properties: { content: { type: 'array', items: {} }, structuredContent: {} },
    required: ['content', 'structuredContent'],
    additionalProperties: false
  },
  render(_args, value) { return value.content }
}

const counters = new Map()

function apply(ctx, config) {
  const prefix = config.conforming ? `mcp__${config.serverName}__` : 'mcp_fixture_nonconforming_'
  const disposers = ['echo', 'counter'].map(rawName => ctx.tools.register({
    name: `${prefix}${rawName}`,
    description: `${config.serverName} acceptance ${rawName}`,
    parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
    output,
    async execute(args) {
      const count = config.counter
        ? (config.counter.value += 1)
        : (counters.set(config.serverName, (counters.get(config.serverName) ?? 0) + 1), counters.get(config.serverName))
      return {
        content: [{ type: 'text', text: args.text ?? rawName }],
        structuredContent: { provider: config.serverName, rawName, count }
      }
    }
  }))
  ctx.effect(() => () => { for (const dispose of disposers.reverse()) dispose() }, `fixture.${config.serverName}`)
}

export { apply }
```

The host test injects an in-memory `counter` object for direct assertions; the browser fixture omits it and uses the module-local counter keyed by `serverName`. The fixture accepts no env, headers, URL, or credential fields.

In `plugin-host-harness.mjs`, install `{ mode: 'manager' }` plus the existing explicit fixture server. Assert:

- cold agents see the shared router but not per-server controls;
- router activation reveals fixture tools to only the requesting agent;
- real MCP echo execution still succeeds;
- the other agent never sees fixture payload schemas;
- turn stopping hides tools before warm connection expiry;
- cleanup restores an empty registry and zero handlers.

- [ ] **Step 5: Run lifecycle/readme tests and verify GREEN**

Run:

```bash
rtk node --test test/plugin-lifecycle.test.mjs test/readme-install.test.mjs
```

Expected: all tests pass and the real fixture process exits cleanly.

- [ ] **Step 6: Commit plugin wiring**

```bash
rtk git add lib/index.js cordis.patch.yml test/fixtures/passive-tool-provider.mjs test/fixtures/plugin-host-harness.mjs test/plugin-lifecycle.test.mjs test/readme-install.test.mjs
rtk git commit -m "feat: enable universal MCP manager bundle"
```

---

### Task 6: DSH Compatibility Matrix and Regression Coverage

**Files:**
- Modify: `test/dsh-version-compat.test.mjs`
- Modify: `test/ci-workflow.test.mjs` only if the existing matrix command cannot exercise manager mode.
- Modify: `.github/workflows/test.yml` only if required by the failing CI contract test.

**Interfaces:**
- Consumes: published host-owned `@deepseek-ai/dsh-tools` APIs for rc.6 and rc.7.
- Produces: a compatibility smoke that installs and disposes both manager and explicit server modes.

- [ ] **Step 1: Write the failing compatibility assertion**

Extend `dsh-version-compat.test.mjs` so its real host context supplies `schemas/get`, one scoped agent with `restrict`, and event emission. Apply `{ mode: 'manager' }`, register a compatible passive MCP tool, emit `agent/created`, and assert the passive tool is hidden while the router is visible. Dispose and assert the passive tool becomes visible again.

- [ ] **Step 2: Run the test against the currently installed graph and verify RED or capability result**

Run: `rtk zsh -lc 'DSH_COMPAT_VERSION=$(node -p "require(\"@deepseek-ai/dsh/package.json\").version") node --test test/dsh-version-compat.test.mjs'`

Expected before fixture changes are complete: FAIL on manager visibility assertions, not on package import.

- [ ] **Step 3: Make only compatibility-bound adapter changes required by the real host**

Do not add a version-string branch. If rc.6 and rc.7 expose different proxy shapes, resolve them through callable capability checks and keep unsupported universal mode fail-open while the explicit server smoke still passes.

- [ ] **Step 4: Run fresh isolated rc.6 and rc.7 host installs**

Run each version in a fresh isolated install using normal peer resolution:

```bash
rtk zsh -lc '
set -euo pipefail
plugin_root=$PWD
for version in 0.1.0-rc.6 0.1.0-rc.7; do
  compat_root=$(mktemp -d /tmp/dsh-mcp-lazy-compat.XXXXXX)
  cp "$plugin_root/package.json" "$plugin_root/package-lock.json" "$compat_root/"
  cp -R "$plugin_root/lib" "$plugin_root/test" "$compat_root/"
  cd "$compat_root"
  npm install --ignore-scripts --no-save "@deepseek-ai/dsh@$version"
  DSH_COMPAT_VERSION=$version node --test --test-name-pattern="requested DSH version" test/dsh-version-compat.test.mjs
  cd "$plugin_root"
done
'
```

Expected for each isolated graph: one compatibility test passes, unrelated tests are skipped by the name pattern, exit code 0.

- [ ] **Step 5: Run the complete local suite**

Run: `rtk npm test`

Expected: zero failures; the compatibility-only test may report one expected skip when `DSH_COMPAT_VERSION` is absent.

- [ ] **Step 6: Commit compatibility coverage**

```bash
rtk git add test/dsh-version-compat.test.mjs test/ci-workflow.test.mjs .github/workflows/test.yml
rtk git commit -m "test: verify universal manager across DSH hosts"
```

Only add files that actually changed; do not stage the workflow when its current matrix already exercises the new assertions.

---

### Task 7: Documentation, Version, and Package Verification

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/readme-install.test.mjs`

**Interfaces:**
- Produces npm version `0.5.0`.
- Documents automatic compatible takeover, passthrough, fail-open, full-lazy versus schema-only behavior, opt-out, and verification.

- [ ] **Step 1: Write failing documentation contract tests**

Require README text and examples covering all of these exact concepts:

```text
mode: manager
mcp-lazy-manager
兼容性准入
不兼容的 MCP 保持原样
fail-open
Schema 按需披露
连接层懒加载
```

Assert `package.json`, `package-lock.json`, and the README title/version section agree on `0.5.0`.

- [ ] **Step 2: Run documentation tests and verify RED**

Run: `rtk node --test test/readme-install.test.mjs test/package-metadata.test.mjs`

Expected: FAIL on missing universal manager documentation and version mismatch.

- [ ] **Step 3: Update README and package version**

Document this decision table:

| MCP 类型 | Schema 行为 | 连接行为 | 失败行为 |
| --- | --- | --- | --- |
| 显式 `dsh-mcp-lazy` server | router 选择后仅向当前会话披露 | 按需启动并保温 | 保留原 lazy 错误并恢复隐藏状态 |
| 通过兼容性准入的其他 DSH MCP | router 选择后仅向当前会话披露 | 原插件保持所有权 | fail-open，恢复原工具面 |
| 不兼容或无法确认的 MCP | 完全不接管 | 完全不接管 | 完全保持 DSH 原样 |

Explain that automatic takeover optimizes model-facing schemas for every compatible DSH MCP but does not claim to stop opaque third-party processes. Include commands to inspect the router-only cold surface and to disable only the `mcp-lazy-manager` entry.

Run `rtk npm version 0.5.0 --no-git-tag-version` to update both package files after documentation tests are RED.

- [ ] **Step 4: Run docs tests and package dry-run**

Run:

```bash
rtk node --test test/readme-install.test.mjs test/package-metadata.test.mjs
rtk npm pack --dry-run
```

Expected: tests pass; tarball includes `lib/mcp-catalog.js`, `lib/universal-manager.js`, `cordis.patch.yml`, README, LICENSE, and excludes tests, temporary reports, `node`, and `npm` untracked files.

- [ ] **Step 5: Run the full suite again**

Run: `rtk npm test`

Expected: zero failures and only the documented compatibility skip when no exact DSH version is injected.

- [ ] **Step 6: Commit docs and release metadata**

```bash
rtk git add README.md package.json package-lock.json test/readme-install.test.mjs test/package-metadata.test.mjs
rtk git commit -m "docs: explain universal MCP compatibility takeover"
```

---

### Task 8: Local DSH and Browser Acceptance

**Files:**
- No permanent source files unless acceptance reveals a defect, in which case start a new RED/GREEN cycle in the owning test file before changing production code.
- Append evidence to: `docs/superpowers/plans/2026-08-20-universal-dsh-mcp-takeover.md` under a final `Acceptance Evidence` section.

**Interfaces:**
- Consumes: local DSH Web profile at `http://127.0.0.1:3080/` and its exact pre-test configuration backup.
- Produces: real browser and API evidence without leaving fixture entries or altered user configuration.

- [x] **Step 1: Record and back up exact local state**

Record SHA-256 hashes of `~/.dsh/cordis.patch.yml`, the Web profile `package.json`, and lockfile. Copy them to a fresh `mktemp -d` directory. Record the formal DSH service label, PID, run count, root HTTP status, and API status before mutation.

- [x] **Step 2: Build a local tarball and install it only in the Web profile**

Run `rtk npm pack` in the repository. Install the resulting `yilinxiao-dsh-mcp-lazy-0.5.0.tgz` into the Web profile without publishing to npm. Add two temporary fixtures to the backed-up user patch:

1. one compatible passive MCP provider exposing at least two real tool schemas and a counter-preserving executor;
2. one deliberately nonconforming MCP-like provider whose tool must remain visible.

Do not include credentials in either fixture.

Use these exact temporary entries:

```yaml
- insert:
    - id: task8-compatible-passive-mcp
      name: 'file:///Users/xiaoyilin/item/mine-item/dsh-mcp-lazy/test/fixtures/passive-tool-provider.mjs'
      config:
        conforming: true
        serverName: task8-passive
    - id: task8-nonconforming-mcp
      name: 'file:///Users/xiaoyilin/item/mine-item/dsh-mcp-lazy/test/fixtures/passive-tool-provider.mjs'
      config:
        conforming: false
        serverName: task8-nonconforming
```

- [x] **Step 3: Restart once and verify service stability**

Restart the formal DSH service once. Poll for 30 seconds and require one stable PID/run count, HTTP 200 for root/API on every poll, no watchdog/one-shot restart jobs, and no new fatal log segment.

- [x] **Step 4: Verify behavior in a real browser conversation**

Using the existing Chrome session and DSH model:

- confirm the cold tool surface includes exactly one shared MCP router for admitted providers;
- confirm the deliberately nonconforming fixture remains directly visible;
- ask for the passive fixture by its unique description and observe `mcp__router__search_and_activate`;
- on the next model step confirm only that passive server's tools are disclosed;
- execute the original passive tool and verify its exact structured result/counter;
- start a second conversation and confirm it still has the cold router-only admitted surface;
- finish the first turn and confirm its passive schemas are hidden again;
- inspect browser console and require zero new error/warn messages attributable to the plugin.

- [x] **Step 5: Restore exact configuration and verify cleanup**

Restore all backed-up profile/user files byte-for-byte, remove only the temporary fixture state and local tarball installation artifacts, restart the formal service once, and verify original hashes, no fixture markers, no backup files in profile directories, one stable PID for 30 seconds, root/API HTTP 200, and a clean browser console.

- [x] **Step 6: Run final source verification after restoration**

Run:

```bash
rtk npm test
rtk npm pack --dry-run
rtk git diff --check
rtk git status --short
```

Expected: zero test failures, successful pack dry-run, no whitespace errors, and only the pre-existing untracked `node` and `npm` files plus the intentionally modified acceptance-evidence plan before it is committed.

- [x] **Step 7: Append acceptance evidence and commit**

Append exact test counts, DSH health observations, Chrome tool-call evidence, passthrough evidence, token/schema comparison, cleanup hashes, and any expected skips. Then run `git diff --check` and commit:

```bash
rtk git add docs/superpowers/plans/2026-08-20-universal-dsh-mcp-takeover.md
rtk git commit -m "test: record universal MCP browser acceptance"
```

---

## Final Review Checklist

- [x] Every acceptance criterion in the spec maps to at least one automated or browser test above.
- [x] No production change was made before its focused test failed for the expected missing behavior.
- [x] Nonconforming and uncertain MCP fixtures remain visible and executable.
- [x] Every manager error path is fail-open.
- [x] Passive rich/structured execution remains owned by the original definition.
- [x] Managed lazy warm-idle and reconnect regressions remain green.
- [x] Node/DSH compatibility matrix, full local suite, package dry-run, DSH service stability, and Chrome acceptance all have fresh evidence.
- [x] Local DSH configuration is restored exactly and no restart watchdog or fixture remains.
- [x] Source tree stages neither the pre-existing `node` nor `npm` untracked files.

## Acceptance Evidence

### Local DSH deployment and compatibility fixture

- Acceptance used the formal local DSH `rc.8` service at `http://127.0.0.1:3080/` and the approved `@yilinxiao/dsh-mcp-lazy@0.5.0` package from commit `8f513a3`.
- The plan's main-checkout fixture URL did not exist. The installed overlay therefore used the exact existing worktree fixture URL `file:///Users/xiaoyilin/item/mine-item/dsh-mcp-lazy/.worktrees/universal-dsh-mcp-takeover/test/fixtures/passive-tool-provider.mjs`; the main checkout was not modified.
- The first real host run found a fixture-only contract defect: Cordis rejected `ctx.tools` access because the fixture lacked injection metadata. A focused lifecycle test first failed on missing `inject`, then the fixture-only export `inject = ['tools']` made the focused test pass. No manager production code changed in that repair; commit `8f513a3` received independent review with zero findings.

### Real Chrome behavior

Fresh Chrome tab `147468613` completed two chronological conversation flows under `0.5.0`:

1. Turn 1 cold catalog: the shared router was present, the deliberately nonconforming tool was present, and the compatible passive echo was absent. The actual router row received `task8-passive acceptance echo` and selected `task8-passive`, disclosing two tools. The following native passive echo received `task8-browser-1` and returned exactly `task8-browser-1`.
2. A separate new conversation again began with the router and nonconforming tool present and the passive echo absent. Its directly visible nonconforming tool received `task8-browser-2-direct` and returned exactly `task8-browser-2-direct`. Its own router activation selected `task8-passive` and disclosed two tools; the native passive echo then received `task8-browser-2-routed` and returned exactly `task8-browser-2-routed`.
3. The second conversation's later prose contradicted its initial catalog observation. Adjudication follows the actual chronological catalog and tool rows: the second conversation started cold and required an independent router activation, proving per-conversation isolation and reset.
4. Console warn/error entries on the successful tab were exactly `[]`.

The compatible fixture defines two real schemas. Cold state disclosed zero of those two schemas and one shared router; routed state disclosed exactly the target provider's two schemas. The deliberately nonconforming fixture stayed directly visible and executable.

The required repeatable schema-token comparison used the integration host's two passive MCP servers (`passive-alpha` and `passive-beta`) plus the existing `managed-fixture`. With universal mode disabled, its cold tool surface contains the shared router, four passive tools, and two managed control tools: 7 schemas. Universal cold mode contains only the shared router: 1 schema. Serializing the exact DSH `{name, description, parameters}` projections as key-sorted compact JSON and encoding both with `tiktoken` `cl100k_base` produced:

```text
baseline:       7 schemas, 404 tokens, 1645 UTF-8 bytes
universal cold: 1 schema,   63 tokens,  259 UTF-8 bytes
reduction:                 341 tokens (84.4%)
```

This measures schema text only and is not presented as a DeepSeek billing-token count. The fixture schemas are deliberately small; the README retains the separate 67-tool real-MCP benchmark for practical scale.

DSH's tool row and Inspect/Event details expose only the fixture's rendered text because `output.render` returns `value.content`; they do not expose `structuredContent`. Chrome evidence therefore does not invent visible `provider`, `rawName`, or counter fields. Exact native executor invocation is established by the tool rows above, while rich/structured result ownership is covered by the source and automated lifecycle tests. This is a UI observability boundary, not an execution failure.

### Client-bootstrap A/B adjudication

During setup, several agent-created tabs stalled at `Loading plugins…` or lost their Web connection even though root, `/health`, `host.describe`, both WebSocket upgrades, and all 56 boot-manifest JavaScript URLs were healthy. A controlled A/B preserved DSH `rc.8`, the exact configuration, and both fixtures while changing only the installed package from `0.5.0` to the authoritative `0.4.1`. The fresh `0.4.1` tab also failed, on the built-in `@deepseek-ai/dsh-client-ui-settings-models/client.js` loader entry. This excluded the `0.5.0` manager and fixtures as the cause. After only four known stale acceptance/error tabs were closed, a fresh `0.5.0` tab completed the successful flow above.

### Restoration and final verification

The authoritative `0.4.1` baseline was restored byte-for-byte:

```text
8e9a3a52a6922f70cef6e0ccb7f39193c00a4b2c8d795c3fb59039ae0ca523a1  ~/.dsh/cordis.patch.yml
5fecb19d86d16a17e263460867106800302e2b96ed276364a286213c9d26763d  ~/.dsh/profiles/web/cordis.patch.yml
0ef9fcfdd789e92d553a87d9ea4d74b068e30a187be04be51bf3bc61317db962  ~/.dsh/profiles/web/package.json
046d74c2f30ddf0031ab07af52225d42a8387a39fe4b4c40b288779a411ef4a6  ~/.dsh/profiles/web/pnpm-lock.yaml
c300dcf2ebc5f02062d6591268d29d3db6fe45e0cb138f5467276fe2ba06076e  ~/.dsh/profiles/web/cordis.yml
```

- Physical installed package version is `0.4.1`; no fixture marker, Task 8 backup under `~/.dsh`, local `0.5.0` tarball, or A/B temporary directory remains.
- After the final formal restart, wrapper PID `68364`, run count `33`, and listener PID `68824` were unchanged from 15:09:18 through 15:09:48. Root and `/health` returned HTTP 200 in all seven samples, `host.describe` returned HTTP 200 with a successful server response, and stderr grew by zero bytes.
- Final `rtk npm test`: 109 tests, 108 passed, 0 failed, and 1 expected compatibility skip (`DSH_COMPAT_VERSION` is injected only by compatibility CI).
- Final `rtk npm pack --dry-run` succeeded for `yilinxiao-dsh-mcp-lazy-0.5.0.tgz`; `rtk git diff --check` passed.

Acceptance adjudication: **PASS**, within the explicitly documented DSH UI observability boundary.
