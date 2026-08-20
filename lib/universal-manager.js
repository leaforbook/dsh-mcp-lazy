import { buildMcpCatalog } from './mcp-catalog.js'
import {
  ROUTER_TOOL_NAME,
  getRouterEntryStatus,
  registerRouterVisibility
} from './tool-router.js'

const managers = new WeakMap()

function emptyCatalog() {
  return { signature: 'empty', servers: new Map(), passthrough: new Set() }
}

function aggregate(errors, message) {
  return new AggregateError(errors, message)
}

function safeMessage(error) {
  if (error instanceof AggregateError) return 'AggregateError'
  if (error instanceof Error) return error.name || 'Error'
  return 'unknown error'
}

function installUniversalManager(adapter) {
  if (!adapter?.supported || (typeof adapter.identity !== 'object' && typeof adapter.identity !== 'function')) {
    adapter?.log?.('error', 'mcp-lazy manager: universal DSH capabilities are unavailable; leaving tools unchanged')
    return () => {}
  }

  const existing = managers.get(adapter.identity)
  if (existing !== undefined) {
    const owner = {}
    existing.owners.set(owner, adapter)
    return createOwnerDisposer(existing, owner)
  }

  const record = createManagerRecord(adapter)
  const owner = {}
  record.owners.set(owner, adapter)
  record.resourceOwner = owner
  managers.set(adapter.identity, record)
  try {
    record.routerDisposer = registerRouterVisibility(adapter, record.controller)
    record.listenerDisposers = installListeners(adapter, record)
    record.controller.reconcile()
  } catch (error) {
    managers.delete(adapter.identity)
    const cleanupErrors = cleanupManager(record)
    adapter.log('error', `mcp-lazy manager: setup failed; leaving tools unchanged (${safeMessage(error)})`)
    for (const cleanupError of cleanupErrors) {
      adapter.log('error', `mcp-lazy manager: setup cleanup failed (${safeMessage(cleanupError)})`)
    }
    return () => {}
  }
  return createOwnerDisposer(record, owner)
}

function createManagerRecord(adapter) {
  const record = {
    adapter,
    owners: new Map(),
    resourceOwner: undefined,
    agents: new Map(),
    retiredAgents: new Set(),
    catalog: emptyCatalog(),
    reconciling: false,
    reconcilePending: false,
    catalogFailureLogged: false,
    disposed: false,
    listenerDisposers: new Set(),
    orphanDisposers: new Set(),
    routerDisposer: undefined,
    controller: undefined
  }

  record.controller = {
    getEntries() {
      return [...routableServers(record).values()].map(server => routerEntryForServer(server, record.adapter))
    },
    reconcile() {
      reconcile(record)
    },
    onAgentCreated(event) {
      onAgentCreated(record, event?.agent)
    },
    onTurnStopping(event) {
      onTurnStopping(record, event?.agent)
    },
    onAgentDisposed(event) {
      onAgentDisposed(record, event?.agent)
    },
    reveal(agent, serverName) {
      return reveal(record, agent, serverName)
    },
    onRouterStateChange() {
      refreshRestrictions(record)
    }
  }
  return record
}

function installListeners(adapter, record) {
  const disposers = new Set()
  try {
    for (const [event, handler] of [
      ['tools/change', () => record.controller.reconcile()],
      ['agent/created', event => record.controller.onAgentCreated(event)],
      ['agent/turn-stopping', event => record.controller.onTurnStopping(event)],
      ['agent/disposed', event => record.controller.onAgentDisposed(event)]
    ]) {
      const dispose = adapter.on(event, handler)
      if (typeof dispose !== 'function') throw new Error(`event listener ${event} did not return a disposer`)
      disposers.add(dispose)
    }
  } catch (error) {
    const errors = [error, ...disposeHandles(disposers)]
    throw aggregate(errors, 'manager listener installation failed')
  }
  return disposers
}

function createOwnerDisposer(record, owner) {
  let released = false
  return () => {
    if (released) {
      if (!record.disposed) return
      const retryErrors = cleanupManager(record)
      if (retryErrors.length > 0) throw aggregate(retryErrors, 'universal MCP manager cleanup retry failed')
      return
    }
    released = true
    const wasResourceOwner = record.resourceOwner === owner
    record.owners.delete(owner)
    if (record.owners.size > 0) {
      if (wasResourceOwner) {
        try {
          transferManagerResources(record, record.owners.entries().next().value)
        } catch (error) {
          record.disposed = true
          managers.delete(record.adapter.identity)
          const cleanupErrors = cleanupManager(record)
          throw aggregate([error, ...cleanupErrors], 'manager transfer failed; universal filtering was removed')
        }
      }
      return
    }
    if (record.disposed) {
      const retryErrors = cleanupManager(record)
      if (retryErrors.length > 0) throw aggregate(retryErrors, 'universal MCP manager cleanup retry failed')
      return
    }
    record.disposed = true
    managers.delete(record.adapter.identity)
    const errors = cleanupManager(record)
    if (errors.length > 0) throw aggregate(errors, 'universal MCP manager cleanup failed')
  }
}

function transferManagerResources(record, [nextOwner, nextAdapter]) {
  const nextListeners = installListeners(nextAdapter, record)
  let transferError
  try {
    record.routerDisposer.transferTo(nextAdapter)
  } catch (error) {
    transferError = error
  }

  const previousListeners = record.listenerDisposers
  record.listenerDisposers = nextListeners
  record.resourceOwner = nextOwner
  record.adapter = nextAdapter
  const cleanupErrors = disposeHandles(previousListeners)
  for (const dispose of previousListeners) record.orphanDisposers.add(dispose)
  if (transferError !== undefined) {
    refreshRestrictions(record)
    throw aggregate([transferError, ...cleanupErrors], 'manager resource ownership transfer failed')
  }
  if (cleanupErrors.length > 0) {
    throw aggregate(cleanupErrors, 'previous manager resource cleanup failed after transfer')
  }
}

function cleanupManager(record) {
  const errors = []

  for (const agentRecord of record.agents.values()) record.retiredAgents.add(agentRecord)
  record.agents.clear()
  for (const agentRecord of [...record.retiredAgents]) {
    const cleanupErrors = disposeRestrictionHandles(agentRecord)
    errors.push(...cleanupErrors)
    if (agentRecord.restrictions.size === 0) record.retiredAgents.delete(agentRecord)
  }

  errors.push(...disposeHandles(record.listenerDisposers))
  errors.push(...disposeHandles(record.orphanDisposers))
  record.catalog = emptyCatalog()

  if (record.routerDisposer !== undefined) {
    try {
      record.routerDisposer()
      record.routerDisposer = undefined
    } catch (error) { errors.push(error) }
  }
  return errors
}

function disposeHandles(handles) {
  const errors = []
  for (const dispose of [...handles].reverse()) {
    try {
      dispose()
      handles.delete(dispose)
    } catch (error) {
      if (error instanceof AggregateError) errors.push(...error.errors)
      else errors.push(error)
    }
  }
  return errors
}

function reconcile(record) {
  if (record.disposed) return
  if (record.reconciling) {
    record.reconcilePending = true
    return
  }

  record.reconciling = true
  try {
    do {
      record.reconcilePending = false
      let next
      try {
        next = buildMcpCatalog({
          schemas: record.adapter.listToolSchemas(),
          getDefinition: name => record.adapter.getTool(name),
          routerName: ROUTER_TOOL_NAME
        })
      } catch (error) {
        record.catalog = emptyCatalog()
        if (!record.catalogFailureLogged) {
          record.catalogFailureLogged = true
          record.adapter.log('error', `mcp-lazy manager: catalog unavailable; leaving tools unchanged (${safeMessage(error)})`)
        }
        for (const agentRecord of record.agents.values()) {
          failOpen(record, agentRecord, error)
        }
        continue
      }

      record.catalogFailureLogged = false
      if (next.signature === record.catalog.signature) continue
      record.catalog = next
      refreshRestrictions(record)
    } while (record.reconcilePending && !record.disposed)
  } finally {
    record.reconciling = false
  }
}

function onAgentCreated(record, agent) {
  if (record.disposed || agent === undefined || agent === null || record.agents.has(agent)) return
  const agentRecord = {
    agent,
    selectedServer: undefined,
    restrictions: new Set(),
    bypassUntilTurnEnd: false,
    failureLogged: false
  }
  record.agents.set(agent, agentRecord)
  try {
    replaceRestriction(record, agentRecord)
  } catch (error) {
    failOpen(record, agentRecord, error)
  }
}

function onTurnStopping(record, agent) {
  const agentRecord = record.agents.get(agent)
  if (agentRecord === undefined || record.disposed) return
  agentRecord.selectedServer = undefined
  agentRecord.bypassUntilTurnEnd = false
  agentRecord.failureLogged = false
  try {
    replaceRestriction(record, agentRecord)
  } catch (error) {
    failOpen(record, agentRecord, error)
  }
}

function onAgentDisposed(record, agent) {
  const agentRecord = record.agents.get(agent)
  if (agentRecord === undefined) return
  record.agents.delete(agent)
  const errors = disposeRestrictionHandles(agentRecord)
  if (agentRecord.restrictions.size > 0) record.retiredAgents.add(agentRecord)
  if (errors.length > 0) {
    record.adapter.log('error', `mcp-lazy manager: agent cleanup failed (${safeMessage(aggregate(errors, 'agent restriction cleanup failed'))})`)
  }
}

function routerEntryForServer(server, adapter) {
  return {
    serverName: server.serverName,
    routingHints: [],
    toolNames: server.toolNames,
    getDefinition: name => adapter.getTool(name),
    getCatalog: server.getCatalog
  }
}

function routableServers(record) {
  const servers = new Map()
  for (const [serverName, server] of record.catalog.servers) {
    const status = getRouterEntryStatus(record.adapter, routerEntryForServer(server, record.adapter))
    if (status.available && (status.kind === 'passive' || status.kind === 'managed')) {
      servers.set(serverName, server)
    }
  }
  return servers
}

function refreshRestrictions(record) {
  if (record.disposed) return
  const routable = routableServers(record)
  for (const agentRecord of record.agents.values()) {
    if (agentRecord.selectedServer !== undefined && !routable.has(agentRecord.selectedServer)) {
      agentRecord.selectedServer = undefined
    }
    if (agentRecord.bypassUntilTurnEnd) continue
    try {
      replaceRestriction(record, agentRecord, routable)
    } catch (error) {
      failOpen(record, agentRecord, error)
    }
  }
}

function replaceRestriction(record, agentRecord, routable = routableServers(record)) {
  if (agentRecord.bypassUntilTurnEnd) return
  if (agentRecord.selectedServer !== undefined && !routable.has(agentRecord.selectedServer)) {
    throw new Error(`selected MCP server "${agentRecord.selectedServer}" is no longer routable`)
  }

  const deny = []
  for (const [serverName, server] of routable) {
    if (serverName !== agentRecord.selectedServer) deny.push(...server.toolNames)
  }
  deny.sort()
  const previous = new Set(agentRecord.restrictions)
  if (deny.length === 0) {
    const cleanupErrors = disposeRestrictionHandles(agentRecord, previous)
    if (cleanupErrors.length > 0) throw aggregate(cleanupErrors, 'restriction removal failed')
    return
  }

  let next
  try {
    next = record.adapter.restrictAgentTools(agentRecord.agent, deny)
    if (typeof next !== 'function') throw new Error('scoped tools.restrict did not return a disposer')
  } catch (error) {
    const cleanupErrors = disposeRestrictionHandles(agentRecord, previous)
    if (cleanupErrors.length === 0) throw error
    throw aggregate([error, ...cleanupErrors], 'restriction replacement and fail-open cleanup failed')
  }

  agentRecord.restrictions.add(next)
  const cleanupErrors = disposeRestrictionHandles(agentRecord, previous)
  if (cleanupErrors.length > 0) throw aggregate(cleanupErrors, 'old restriction cleanup failed')
}

function disposeRestrictionHandles(agentRecord, handles = new Set(agentRecord.restrictions)) {
  const errors = []
  for (const restriction of handles) {
    if (!agentRecord.restrictions.has(restriction)) continue
    try {
      restriction()
      // A throwing disposer may still represent an active deny mask, so only a
      // successful call permits forgetting the handle.
      agentRecord.restrictions.delete(restriction)
    } catch (error) {
      if (error instanceof AggregateError) errors.push(...error.errors)
      else errors.push(error)
    }
  }
  return errors
}

function failOpen(record, agentRecord, error) {
  agentRecord.selectedServer = undefined
  agentRecord.bypassUntilTurnEnd = true
  let failure = error
  const cleanupErrors = disposeRestrictionHandles(agentRecord)
  if (cleanupErrors.length > 0) failure = aggregate([error, ...cleanupErrors], 'manager failure and restriction cleanup failed')
  if (!agentRecord.failureLogged) {
    agentRecord.failureLogged = true
    record.adapter.log('error', `mcp-lazy manager: scoped disclosure unavailable; agent left unrestricted (${safeMessage(failure)})`)
  }
  return failure
}

function reveal(record, agent, serverName) {
  const agentRecord = record.agents.get(agent)
  if (agentRecord === undefined) throw new Error('requesting agent is not managed')
  if (agentRecord.bypassUntilTurnEnd) throw new Error('agent disclosure is bypassed until turn end')
  const routable = routableServers(record)
  const server = routable.get(serverName)
  if (server === undefined) {
    throw failOpen(record, agentRecord, new Error(`MCP server "${serverName}" is not admitted and routable`))
  }

  agentRecord.selectedServer = serverName
  try {
    replaceRestriction(record, agentRecord, routable)
  } catch (error) {
    throw failOpen(record, agentRecord, error)
  }
  return `${server.toolNames.length} 个工具已披露`
}

export { installUniversalManager }
