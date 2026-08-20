import { buildMcpCatalog } from './mcp-catalog.js'
import { ROUTER_TOOL_NAME, registerRouterVisibility } from './tool-router.js'

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
    existing.owners += 1
    return createOwnerDisposer(existing)
  }

  const record = createManagerRecord(adapter)
  managers.set(adapter.identity, record)
  try {
    record.routerDisposer = registerRouterVisibility(adapter, record.controller)
    for (const [event, handler] of [
      ['tools/change', () => record.controller.reconcile()],
      ['agent/created', event => record.controller.onAgentCreated(event)],
      ['agent/turn-stopping', event => record.controller.onTurnStopping(event)],
      ['agent/disposed', event => record.controller.onAgentDisposed(event)]
    ]) {
      const dispose = adapter.on(event, handler)
      if (typeof dispose !== 'function') throw new Error(`event listener ${event} did not return a disposer`)
      record.listenerDisposers.push(dispose)
    }
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
  return createOwnerDisposer(record)
}

function createManagerRecord(adapter) {
  const record = {
    adapter,
    owners: 1,
    agents: new Map(),
    catalog: emptyCatalog(),
    reconciling: false,
    reconcilePending: false,
    catalogFailureLogged: false,
    disposed: false,
    listenerDisposers: [],
    routerDisposer: undefined,
    controller: undefined
  }

  record.controller = {
    getEntries() {
      return [...record.catalog.servers.values()].map(server => ({
        serverName: server.serverName,
        routingHints: [],
        getCatalog: server.getCatalog
      }))
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
    }
  }
  return record
}

function createOwnerDisposer(record) {
  let active = true
  return () => {
    if (!active) return
    active = false
    record.owners -= 1
    if (record.owners > 0 || record.disposed) return
    record.disposed = true
    managers.delete(record.adapter.identity)
    const errors = cleanupManager(record)
    if (errors.length > 0) throw aggregate(errors, 'universal MCP manager cleanup failed')
  }
}

function cleanupManager(record) {
  const errors = []

  for (const agentRecord of record.agents.values()) {
    try { liftRestriction(agentRecord) } catch (error) { errors.push(error) }
  }
  record.agents.clear()

  for (const dispose of [...record.listenerDisposers].reverse()) {
    try { dispose() } catch (error) { errors.push(error) }
  }
  record.listenerDisposers.length = 0
  record.catalog = emptyCatalog()

  if (record.routerDisposer !== undefined) {
    const dispose = record.routerDisposer
    record.routerDisposer = undefined
    try { dispose() } catch (error) { errors.push(error) }
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
      for (const agentRecord of record.agents.values()) {
        if (agentRecord.selectedServer !== undefined && !next.servers.has(agentRecord.selectedServer)) {
          agentRecord.selectedServer = undefined
        }
        if (agentRecord.bypassUntilTurnEnd) continue
        try {
          replaceRestriction(record, agentRecord)
        } catch (error) {
          failOpen(record, agentRecord, error)
        }
      }
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
    restriction: undefined,
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
  try {
    liftRestriction(agentRecord)
  } catch (error) {
    record.adapter.log('error', `mcp-lazy manager: agent cleanup failed (${safeMessage(error)})`)
  }
}

function deniedNames(record, selectedServer) {
  const deny = []
  for (const [serverName, server] of record.catalog.servers) {
    if (serverName !== selectedServer) deny.push(...server.toolNames)
  }
  return deny.sort()
}

function replaceRestriction(record, agentRecord) {
  if (agentRecord.bypassUntilTurnEnd) return
  if (agentRecord.selectedServer !== undefined && !record.catalog.servers.has(agentRecord.selectedServer)) {
    throw new Error(`selected MCP server "${agentRecord.selectedServer}" is no longer routable`)
  }

  const deny = deniedNames(record, agentRecord.selectedServer)
  const previous = agentRecord.restriction
  if (deny.length === 0) {
    agentRecord.restriction = undefined
    if (previous !== undefined) previous()
    return
  }

  let next
  try {
    next = record.adapter.restrictAgentTools(agentRecord.agent, deny)
    if (typeof next !== 'function') throw new Error('scoped tools.restrict did not return a disposer')
  } catch (error) {
    agentRecord.restriction = undefined
    if (previous === undefined) throw error
    try {
      previous()
    } catch (cleanupError) {
      throw aggregate([error, cleanupError], 'restriction replacement and fail-open cleanup failed')
    }
    throw error
  }

  agentRecord.restriction = next
  if (previous !== undefined) {
    try {
      previous()
    } catch (error) {
      agentRecord.restriction = undefined
      try {
        next()
      } catch (cleanupError) {
        throw aggregate([error, cleanupError], 'old and new restriction cleanup failed')
      }
      throw error
    }
  }
}

function liftRestriction(agentRecord) {
  const restriction = agentRecord.restriction
  agentRecord.restriction = undefined
  if (restriction !== undefined) restriction()
}

function failOpen(record, agentRecord, error) {
  agentRecord.selectedServer = undefined
  agentRecord.bypassUntilTurnEnd = true
  let failure = error
  try {
    liftRestriction(agentRecord)
  } catch (cleanupError) {
    failure = aggregate([error, cleanupError], 'manager failure and restriction cleanup failed')
  }
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
  const server = record.catalog.servers.get(serverName)
  const routable = record.controller.getEntries().some(entry => entry.serverName === serverName)
  if (server === undefined || !routable) {
    throw failOpen(record, agentRecord, new Error(`MCP server "${serverName}" is not admitted and routable`))
  }

  agentRecord.selectedServer = serverName
  try {
    replaceRestriction(record, agentRecord)
  } catch (error) {
    throw failOpen(record, agentRecord, error)
  }
  return `${server.toolNames.length} 个工具已披露`
}

export { installUniversalManager }
