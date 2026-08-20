# Universal DSH MCP Takeover Design

## Status

Revised direction: every compatible MCP tool registered in DSH is governed by one shared lazy router. Existing `@yilinxiao/dsh-mcp-lazy` server entries retain full connection-level lazy loading; another DSH MCP implementation is covered at the tool-schema visibility layer only after it proves compatible. A provider that cannot be classified, routed, and disclosed safely remains completely untouched.

## Goal

Installing `@yilinxiao/dsh-mcp-lazy` must be sufficient for compatible current and future DSH MCP servers to stop contributing their full tool schemas to every model request. Users must not need to copy each newly installed compatible MCP server into a separate lazy configuration, and an incompatible server must behave exactly as it did without the manager.

## Scope

The universal manager considers global DSH tools whose public names follow the DSH MCP contract:

```text
mcp__<serverName>__<toolName>
```

The fixed shared router `mcp__router__search_and_activate` is the only managed MCP control schema that remains visible by default. Ordinary DSH tools and MCP servers that fail compatibility admission are not filtered.

Compatibility admission is atomic per server namespace. A server is managed only when all of these conditions hold:

1. every tool selected for that server has an unambiguous public name matching `mcp__<serverName>__<toolName>`;
2. `serverName` satisfies the DSH `[A-Za-z0-9_-]{1,32}` contract with exact case preserved;
3. every selected name resolves to the same global definition projected by `ctx.tools.schemas()`;
4. the server can be represented by exactly one managed or passive router entry without a native-router collision;
5. a scoped restriction can hide and subsequently disclose the complete server set atomically.

The manager enforces this invariant:

```text
hidden(server, agent) => classified(server) && routable(server) && revealable(server, agent)
```

If the invariant cannot be proven, none of that server's tools are added to a deny mask. They remain visible and executable through the original DSH behavior.

Two execution modes coexist:

1. **Managed lazy server:** an explicit `@yilinxiao/dsh-mcp-lazy` server entry owns the MCP transport. The manager hides its control and payload schemas from unrelated agents; activation starts or reuses the MCP connection and publishes its payload schemas only to the requesting agent.
2. **Compatible passive DSH MCP server:** another DSH plugin owns the transport and tool definitions. After atomic compatibility admission, the manager hides those definitions from model presentation and reveals the selected server to one agent on demand. Calls still execute through the original definition, preserving the provider's output, attachment, retry, reconnect, and permission behavior.
3. **Passthrough server:** a provider that violates the naming contract, collides with the router, exposes an incomplete or unstable catalog, or cannot be restricted safely is not registered with the lazy router and is never hidden.

## Non-goals

- Do not rewrite `cordis.yml`, `cordis.patch.yml`, profile bundles, or user credentials.
- Do not monkeypatch `ctx.tools.register()` or depend on ToolRuntime private fields.
- Do not forcibly stop an opaque third-party MCP process. Connection-level lazy loading requires an explicit managed-lazy entry until DSH exposes a transport-neutral connection ownership API.
- Do not classify arbitrary tools by description or package name. The public `mcp__...__...` naming contract starts compatibility admission but is not, by itself, permission to hide a tool.
- Do not change tool results, execution policy, attachments, or MCP protocol payloads for passive servers.

## Architecture

### 1. Universal manager entry

The package bundle installs one enabled manager entry:

```yaml
- insert:
    - id: mcp-lazy-manager
      name: '@yilinxiao/dsh-mcp-lazy'
      config:
        mode: manager
```

`Config` becomes a union of `ManagerConfig` and the existing server transport config. A manager is shared per underlying DSH tool service identity; a duplicate manager entry increments ownership without publishing another router or another event listener. Disposing the last owner removes all restrictions and listeners.

An omitted config remains a no-op for compatibility with hosts that probe or auto-insert a package without its bundle configuration.

### 2. MCP catalog

A focused catalog module reads `ctx.tools.schemas()` in the global scope, validates each matching definition with `ctx.tools.get()`, and groups compatible names by exact `serverName`. It retains only model-facing schema data needed for routing: public name, raw suffix, description, and parameters fingerprint. It never reads arguments, environment variables, URLs, headers, or loader configuration.

The catalog excludes the shared router from server payload groups. Exact-case server names remain distinct. Normalized or hashed tool suffixes are opaque routing text; execution continues to use the original public name. Admission produces two explicit sets: compatible router entries and passthrough names. Passthrough names never enter a manager-owned restriction.

The manager reconciles on startup and on `tools/change`. A catalog signature prevents restriction-generated `tools/change` events from causing an update loop. Reconciliation is synchronous and reentrancy-guarded. A changed server snapshot is validated in full before it replaces the last admitted snapshot. If validation fails, the server changes to passthrough before the next model assembly rather than remaining partially hidden.

### 3. Per-agent visibility controller

On `agent/created`, the manager records the agent and installs an agent-scoped `agent.ctx.tools.restrict({ deny })` mask containing only admitted MCP tools, except the shared router. Restrictions are replaced whenever the catalog or selected server changes.

Each agent owns an independent selection:

- Default: all admitted MCP server tools, including per-server `activate` and `deactivate`, are denied. Passthrough tools remain visible.
- Router selects server `S`: tools belonging to `S` are removed from that agent's deny mask; every other MCP server remains denied.
- A second route in the same turn replaces the first selection rather than accumulating schemas.
- `agent/turn-stopping`: selection is cleared and the full MCP deny mask is restored.
- `agent/disposed`: the restriction disposer and agent state are removed.

Scoped restrictions are the DSH-supported progressive-disclosure mechanism. They keep schema presentation, lookup, and execution aligned: a hidden MCP tool cannot be called by name until it has been disclosed. Before committing a new mask, the controller verifies that every denied server has a router entry and that the selected server is absent from the deny set. If this check or the restriction call fails, the controller disposes its restriction for that agent and leaves the original tool surface visible.

### 4. Shared router integration

The existing router registry gains a visibility-controller attachment and passive catalog entries.

Managed lazy entries keep their existing `activate(agent, signal)` behavior. After activation publishes or restores schemas, the router asks the visibility controller to reveal that exact server to the requesting agent before returning.

Passive entries are derived only from the admitted catalog. Their activation operation only reveals the already registered tools to the requesting agent. Routing uses the same deterministic precedence as today:

1. exact `serverName`;
2. exact public tool prefix;
3. configured hints for managed entries;
4. cached tool names and descriptions;
5. no activation on zero score or a tied top score.

If a managed and passive entry share a server name, the managed entry wins only when the passive tools are the generation published by that managed entry. Any other collision makes the namespace passthrough. Passive discovery must never duplicate or replace an explicit managed registration.

The router output remains bounded: it reports the selected server and count, not the complete tool list or schemas.

## Data flow

### Passive DSH MCP

```text
compatible MCP plugin registers mcp__foo__* globally
  -> DSH emits tools/change
  -> manager validates and admits foo, then refreshes agent deny masks
  -> model sees only mcp__router__search_and_activate
  -> router selects foo
  -> manager replaces this agent's mask
  -> next model step sees only foo's MCP tools
  -> original MCP definition executes unchanged
  -> turn-stopping hides foo again
```

### Managed lazy MCP

```text
manager already knows the managed server and its hints/cached catalog
  -> model calls shared router
  -> managed runtime starts or reuses the MCP connection
  -> runtime publishes mcp__foo__* globally
  -> manager hides them from all unrelated agents
  -> manager reveals foo to the requesting agent
  -> turn-stopping hides schemas and existing runtime ownership rules unload them globally
```

### Incompatible or failed admission

```text
MCP-like provider registers an ambiguous, colliding, or unsupported surface
  -> manager cannot prove classified + routable + revealable
  -> provider is marked passthrough
  -> no provider tool enters a manager deny mask
  -> original schemas and execution remain available to every applicable agent
```

## Failure handling

- If the host lacks `tools.schemas`, `tools.get`, scoped `tools.restrict`, `tools/change`, `agent/created`, or `agent/turn-stopping`, the manager logs one actionable compatibility error and does not install any universal restrictions. Explicit server entries continue to use their existing behavior.
- If replacing a restriction fails because the registry changed during reconciliation, the manager disposes its restriction for that agent, marks the affected snapshot passthrough, and logs the server without exposing configuration secrets. It retries admission only after a later stable catalog change or turn boundary.
- A router activation is successful only after both the underlying managed activation (when applicable) and the requesting agent's disclosure succeed. If passive disclosure fails, the agent fails open to the original unrestricted surface for the rest of the current turn.
- Removing the selected server clears that selection. Removing unrelated servers updates the deny mask without disturbing the selected server.
- Manager disposal is idempotent and attempts every cleanup even if one disposer throws; multiple failures are combined. Cleanup always attempts to lift restrictions before removing catalog and router state.

## Compatibility and security

- Minimum supported DSH is the tested `0.1.0-rc.6`/`0.1.0-rc.7`/`0.1.0-rc.8` range, but universal mode is capability-gated rather than version-string-gated.
- Catalog state contains schemas already present in the DSH tool registry, never MCP credentials or configuration files.
- Agent selections use object identity/weak ownership rather than user-controlled string IDs, preventing one conversation from changing another conversation's visibility.
- No MCP schema or complete tool-name list is returned in router results.
- Passive execution preserves the exact original `ToolDefinition`, including images, attachments, structured content, guards, and auditing.
- Compatibility uncertainty always fails open: the cost is losing token savings for that server, never losing access to its tools.

## Configuration and upgrade behavior

- New installations receive the enabled manager bundle entry automatically.
- Existing installations upgrading from 0.4.x receive the manager entry through the package bundle; their explicit lazy server entries remain valid.
- Users can disable universal takeover by disabling only `mcp-lazy-manager`; explicit lazy server entries continue to work.
- The README must distinguish universal schema takeover from full connection-level lazy loading and explain how to verify both.

## Testing

### Unit tests

- Parse and group exact MCP names; exclude ordinary tools and the shared router.
- Reject malformed, mixed, colliding, unresolved, and native-router-conflicting namespaces as passthrough.
- Preserve case-distinct servers and deterministic catalog signatures.
- Maintain independent agent selections and replace, rather than accumulate, disclosed servers.
- Handle catalog add/change/remove and restriction reentrancy.
- Prefer managed router entries over passive entries with the same server name.

### Integration tests

- A host with two eager MCP providers exposes only the shared router to a new agent.
- Routing one provider reveals only that provider on the next schema projection.
- A second agent remains isolated.
- Turn stopping hides the provider again.
- A provider registered after agent creation is automatically hidden.
- A provider tool-list change updates routing and visibility without duplicate registrations.
- A passive provider's original executor and structured/rich output remain unchanged.
- A nonconforming provider remains fully visible and executable, with no router entry and no partial filtering.
- Missing host capabilities, catalog races, and restriction failures remove manager filtering and preserve the original tool surface.
- A managed lazy provider starts on route, remains hidden from other agents, and follows existing warm-idle behavior.
- Manager HMR/disposal restores the original unrestricted surface without leaks.

### Compatibility and real smoke tests

- Run the complete Node test suite.
- Run isolated host lifecycle tests against supported DSH rc.6, rc.7, and rc.8 dependency graphs.
- Start the local DSH Web profile, verify root/API health, and use a real browser conversation to confirm: router-only cold schema, selective disclosure, cross-turn unload, cross-session isolation, and zero browser console errors.
- Compare schema token counts before and after universal mode with at least two passive MCP servers and the existing managed MCP fixture.

## Acceptance criteria

1. Adding a compatible DSH MCP provider after the manager is installed requires no `dsh-mcp-lazy` server entry to remove its schemas from default model context.
2. Exactly one shared router schema remains visible by default, regardless of MCP server count.
3. Routing reveals only the selected server to only the requesting agent.
4. Turn end and agent disposal restore the hidden state without affecting other agents.
5. Passive MCP execution quality and results are byte-for-byte behaviorally owned by the original provider.
6. Existing explicit lazy configurations and warm connection reuse remain compatible.
7. Full automated tests and real DSH browser acceptance pass before release.
8. Every incompatible or uncertain MCP provider remains passthrough; no test may observe a provider that is hidden but unavailable through the router.
