# Universal DSH MCP Takeover Design

## Status

Approved direction: every MCP tool registered in DSH is governed by one shared lazy router. Existing `@yilinxiao/dsh-mcp-lazy` server entries retain full connection-level lazy loading; any other DSH MCP implementation is covered at the tool-schema visibility layer without changing its execution behavior.

## Goal

Installing `@yilinxiao/dsh-mcp-lazy` must be sufficient for current and future DSH MCP servers to stop contributing their full tool schemas to every model request. Users must not need to copy each newly installed MCP server into a separate lazy configuration.

## Scope

The universal manager covers every global DSH tool whose public name follows the DSH MCP contract:

```text
mcp__<serverName>__<toolName>
```

The fixed shared router `mcp__router__search_and_activate` is the only MCP control schema that remains visible by default. Ordinary DSH tools are not filtered.

Two execution modes coexist:

1. **Managed lazy server:** an explicit `@yilinxiao/dsh-mcp-lazy` server entry owns the MCP transport. The manager hides its control and payload schemas from unrelated agents; activation starts or reuses the MCP connection and publishes its payload schemas only to the requesting agent.
2. **Passive DSH MCP server:** any other DSH plugin owns the transport and tool definitions. The manager hides those definitions from model presentation and reveals the selected server to one agent on demand. Calls still execute through the original definition, preserving the provider's output, attachment, retry, reconnect, and permission behavior.

## Non-goals

- Do not rewrite `cordis.yml`, `cordis.patch.yml`, profile bundles, or user credentials.
- Do not monkeypatch `ctx.tools.register()` or depend on ToolRuntime private fields.
- Do not forcibly stop an opaque third-party MCP process. Connection-level lazy loading requires an explicit managed-lazy entry until DSH exposes a transport-neutral connection ownership API.
- Do not classify arbitrary tools by description or package name. The public `mcp__...__...` naming contract is the authoritative boundary.
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

A focused catalog module reads `ctx.tools.schemas()` in the global scope and groups matching names by exact `serverName`. It retains only model-facing schema data needed for routing: public name, raw suffix, description, and parameters fingerprint. It never reads arguments, environment variables, URLs, headers, or loader configuration.

The catalog excludes the shared router from server payload groups. Exact-case server names remain distinct. Normalized or hashed tool suffixes are opaque routing text; execution continues to use the original public name.

The manager reconciles on startup and on `tools/change`. A catalog signature prevents restriction-generated `tools/change` events from causing an update loop. Reconciliation is synchronous and reentrancy-guarded so a newly registered MCP schema cannot reach the next model assembly before the relevant agent restrictions are refreshed.

### 3. Per-agent visibility controller

On `agent/created`, the manager records the agent and installs an agent-scoped `agent.ctx.tools.restrict({ deny })` mask containing every MCP tool except the shared router. Restrictions are replaced whenever the catalog or selected server changes.

Each agent owns an independent selection:

- Default: all MCP server tools, including per-server `activate` and `deactivate`, are denied.
- Router selects server `S`: tools belonging to `S` are removed from that agent's deny mask; every other MCP server remains denied.
- A second route in the same turn replaces the first selection rather than accumulating schemas.
- `agent/turn-stopping`: selection is cleared and the full MCP deny mask is restored.
- `agent/disposed`: the restriction disposer and agent state are removed.

Scoped restrictions are the DSH-supported progressive-disclosure mechanism. They keep schema presentation, lookup, and execution aligned: a hidden MCP tool cannot be called by name until it has been disclosed.

### 4. Shared router integration

The existing router registry gains a visibility-controller attachment and passive catalog entries.

Managed lazy entries keep their existing `activate(agent, signal)` behavior. After activation publishes or restores schemas, the router asks the visibility controller to reveal that exact server to the requesting agent before returning.

Passive entries are derived from the catalog. Their activation operation only reveals the already registered tools to the requesting agent. Routing uses the same deterministic precedence as today:

1. exact `serverName`;
2. exact public tool prefix;
3. configured hints for managed entries;
4. cached tool names and descriptions;
5. no activation on zero score or a tied top score.

If a managed and passive entry share a server name, the managed entry wins. Passive discovery must never duplicate or replace an explicit managed registration.

The router output remains bounded: it reports the selected server and count, not the complete tool list or schemas.

## Data flow

### Passive DSH MCP

```text
MCP plugin registers mcp__foo__* globally
  -> DSH emits tools/change
  -> manager catalogs foo and refreshes agent deny masks
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

## Failure handling

- If the host lacks `tools.schemas`, scoped `tools.restrict`, `tools/change`, `agent/created`, or `agent/turn-stopping`, the manager logs one actionable compatibility error and does not partially install. Explicit server entries continue to use their existing behavior.
- If replacing a restriction fails because the registry changed during reconciliation, the manager re-reads the catalog once. If the retry fails, it retains the last valid restriction and logs the agent/server without exposing configuration secrets.
- A router activation is successful only after both the underlying managed activation (when applicable) and the requesting agent's disclosure succeed.
- Removing the selected server clears that selection. Removing unrelated servers updates the deny mask without disturbing the selected server.
- Manager disposal is idempotent and attempts every cleanup even if one disposer throws; multiple failures are combined.

## Compatibility and security

- Minimum supported DSH remains the tested rc.6/rc.7 range, but universal mode is capability-gated rather than version-string-gated.
- Catalog state contains schemas already present in the DSH tool registry, never MCP credentials or configuration files.
- Agent selections use object identity/weak ownership rather than user-controlled string IDs, preventing one conversation from changing another conversation's visibility.
- No MCP schema or complete tool-name list is returned in router results.
- Passive execution preserves the exact original `ToolDefinition`, including images, attachments, structured content, guards, and auditing.

## Configuration and upgrade behavior

- New installations receive the enabled manager bundle entry automatically.
- Existing installations upgrading from 0.4.x receive the manager entry through the package bundle; their explicit lazy server entries remain valid.
- Users can disable universal takeover by disabling only `mcp-lazy-manager`; explicit lazy server entries continue to work.
- The README must distinguish universal schema takeover from full connection-level lazy loading and explain how to verify both.

## Testing

### Unit tests

- Parse and group exact MCP names; exclude ordinary tools and the shared router.
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
- A managed lazy provider starts on route, remains hidden from other agents, and follows existing warm-idle behavior.
- Manager HMR/disposal restores the original unrestricted surface without leaks.

### Compatibility and real smoke tests

- Run the complete Node test suite.
- Run isolated host lifecycle tests against supported DSH rc.6 and rc.7 dependency graphs.
- Start the local DSH Web profile, verify root/API health, and use a real browser conversation to confirm: router-only cold schema, selective disclosure, cross-turn unload, cross-session isolation, and zero browser console errors.
- Compare schema token counts before and after universal mode with at least two passive MCP servers and the existing managed MCP fixture.

## Acceptance criteria

1. Adding a conforming DSH MCP provider after the manager is installed requires no `dsh-mcp-lazy` server entry to remove its schemas from default model context.
2. Exactly one shared router schema remains visible by default, regardless of MCP server count.
3. Routing reveals only the selected server to only the requesting agent.
4. Turn end and agent disposal restore the hidden state without affecting other agents.
5. Passive MCP execution quality and results are byte-for-byte behaviorally owned by the original provider.
6. Existing explicit lazy configurations and warm connection reuse remain compatible.
7. Full automated tests and real DSH browser acceptance pass before release.
