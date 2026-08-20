const ROUTER_TOOL_NAME = 'mcp__router__search_and_activate'
const registries = new WeakMap()

function canonicalText(value) {
  return String(value ?? '').normalize('NFKC')
}

function normalized(value) {
  return canonicalText(value).toLowerCase()
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

function selectRoute(entries, { query, serverName } = {}) {
  const sorted = [...entries].sort((left, right) => left.serverName.localeCompare(right.serverName))
  if (serverName) return { entry: sorted.find((item) => item.serverName === serverName), candidates: [] }
  const prefix = canonicalText(query).match(/mcp__([a-z0-9_-]{1,32})__/i)?.[1]
  if (prefix) {
    const exact = sorted.find((item) => item.serverName === prefix)
    if (exact !== undefined) return { entry: exact, candidates: [] }
    const folded = sorted.filter((item) => normalized(item.serverName) === normalized(prefix))
    return {
      entry: folded.length === 1 ? folded[0] : undefined,
      candidates: folded.length === 1 ? [] : folded.slice(0, 5)
    }
  }
  const ranked = sorted
    .map((entry) => ({ entry, score: scoreEntry(query, entry) }))
    .sort((a, b) => b.score - a.score || a.entry.serverName.localeCompare(b.entry.serverName))
  const top = ranked[0]?.score ?? 0
  const candidates = ranked.filter((item) => item.score === top && top > 0).map((item) => item.entry)
  return { entry: candidates.length === 1 ? candidates[0] : undefined, candidates: candidates.slice(0, 5) }
}

function textOutput() {
  return {
    schema: {
      type: 'object',
      properties: { content: { type: 'array', items: {} } },
      required: ['content'],
      additionalProperties: false
    },
    render(_args, value) {
      const text = (value.content ?? [])
        .filter((block) => block && typeof block === 'object' && block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      return [{ type: 'text', text }]
    }
  }
}

function candidateSummary(candidates) {
  if (candidates.length === 0) {
    return '未找到匹配的 MCP 服务器。请提供更具体的查询，或指定 serverName。'
  }
  const names = candidates.map((entry) => {
    const hints = (entry.routingHints ?? []).slice(0, 3)
    return hints.length > 0
      ? `${entry.serverName}（提示：${hints.join('、')}）`
      : entry.serverName
  })
  return `匹配到多个 MCP 服务器，请提供更具体的查询或指定 serverName：${names.join('、')}。`
}

function firstEntryRecord(registry) {
  return registry.entries.values().next().value
}

function hasRouterSource(registry) {
  return registry.entries.size > 0 || registry.visibility !== undefined
}

function firstPublicationOwner(registry) {
  return firstEntryRecord(registry) ?? registry.visibility
}

function isPublicationOwner(registry, owner) {
  return registry.entries.get(owner?.entry?.serverName) === owner || registry.visibility === owner
}

function notifyRouterState(registry) {
  registry.visibility?.controller.onRouterStateChange?.()
}

function publishSharedRouter(registry, preferredOwner) {
  if (registry.sharedPublication !== undefined || registry.nativeOwner !== undefined || !hasRouterSource(registry)) return
  const owner = preferredOwner !== undefined && isPublicationOwner(registry, preferredOwner)
    ? preferredOwner
    : firstPublicationOwner(registry)
  const dispose = owner.adapter.registerTool(registry.definition)
  registry.sharedPublication = { owner, dispose, disposed: false }
  notifyRouterState(registry)
}

function unpublishSharedRouter(registry, { notify = true } = {}) {
  const publication = registry.sharedPublication
  if (publication === undefined) return
  registry.sharedPublication = undefined
  if (notify) notifyRouterState(registry)
  if (publication.disposed) return
  publication.disposed = true
  publication.dispose()
}

function combineErrors(primary, cleanup, message) {
  if (primary === undefined) return cleanup
  if (cleanup === undefined) return primary
  return new AggregateError([primary, cleanup], message)
}

function errorFromList(errors, message) {
  if (errors.length === 0) return undefined
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, message)
}

function disposeOrphan(registry, dispose) {
  try {
    dispose()
    registry.orphanDisposers.delete(dispose)
    return undefined
  } catch (error) {
    registry.orphanDisposers.add(dispose)
    return error
  }
}

function retryOrphanDisposers(registry) {
  const errors = []
  for (const dispose of [...registry.orphanDisposers]) {
    const error = disposeOrphan(registry, dispose)
    if (error !== undefined) errors.push(error)
  }
  return errors
}

function requireOrphanCleanup(registry) {
  const failure = errorFromList(retryOrphanDisposers(registry), 'retained router cleanup failed')
  if (failure !== undefined) throw failure
}

function maybeDeleteRegistry(registry) {
  if (!hasRouterSource(registry) && registry.nativeOwner === undefined && registry.orphanDisposers.size === 0) {
    registries.delete(registry.identity)
  }
}

function retryRetainedCleanup(registry, message) {
  const failure = errorFromList(retryOrphanDisposers(registry), message)
  maybeDeleteRegistry(registry)
  if (failure !== undefined) throw failure
}

function releaseNativeOwner(registry, owner) {
  if (owner.disposed) {
    retryRetainedCleanup(registry, 'native-owner retained cleanup failed')
    return
  }
  owner.disposed = true
  let failure
  try { owner.dispose() } catch (error) { failure = error }
  if (registry.nativeOwner === owner) {
    registry.nativeOwner = undefined
    if (!hasRouterSource(registry)) maybeDeleteRegistry(registry)
    else {
      try { publishSharedRouter(registry) } catch (restoreError) {
        failure = combineErrors(failure, restoreError, 'native router disposal and shared-router restoration failed')
      }
    }
  }
  failure = combineErrors(
    failure,
    errorFromList(retryOrphanDisposers(registry), 'native-owner retained cleanup failed'),
    'native router disposal and retained cleanup failed'
  )
  maybeDeleteRegistry(registry)
  if (failure !== undefined) throw failure
}

function createRegistry(identity) {
  const registry = {
    identity,
    definition: undefined,
    entries: new Map(),
    visibility: undefined,
    nativeOwner: undefined,
    sharedPublication: undefined,
    orphanDisposers: new Set()
  }
  registry.definition = {
    name: ROUTER_TOOL_NAME,
    description: '搜索并激活最匹配的 MCP 服务器。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        serverName: { type: 'string' }
      },
      required: ['query'],
      additionalProperties: false
    },
    output: textOutput(),
    execute: async (args, exec) => {
      const managed = [...registry.entries.values()].map((record) => record.entry)
      const passive = (registry.visibility?.controller.getEntries() ?? [])
        .filter((entry) => getRouterEntryStatusByRegistry(registry, entry).kind === 'passive')
      const route = selectRoute([...managed, ...passive], args)
      if (route.entry !== undefined) {
        const record = registry.entries.get(route.entry.serverName)
        const result = record === undefined
          ? await registry.visibility.controller.reveal(exec.agent, route.entry.serverName)
          : await record.entry.activate(exec.agent, exec.signal)
        if (record !== undefined && registry.visibility !== undefined) {
          await registry.visibility.controller.reveal(exec.agent, route.entry.serverName)
        }
        return {
          content: [{ type: 'text', text: `已选择 MCP 服务器 "${route.entry.serverName}"：${result}` }]
        }
      }
      return { content: [{ type: 'text', text: candidateSummary(route.candidates) }] }
    }
  }
  registries.set(identity, registry)
  return registry
}

function entryToolNames(entry) {
  const names = entry.toolNames ?? entry.getCatalog().map(tool => tool.name)
  return new Set(names)
}

function sameSet(left, right) {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

function getRouterEntryStatusByRegistry(registry, entry) {
  if (registry.visibility === undefined || registry.nativeOwner !== undefined || registry.sharedPublication === undefined) {
    return { available: false, kind: 'unavailable' }
  }
  const managed = registry.entries.get(entry.serverName)
  if (managed === undefined) return { available: true, kind: 'passive' }

  const names = entryToolNames(entry)
  const controls = new Set([
    `mcp__${entry.serverName}__activate`,
    `mcp__${entry.serverName}__deactivate`
  ])
  const passivePayload = new Set([...names].filter(name => !controls.has(name)))
  const published = new Set(managed.publishedTools.keys())
  // A same-name namespace is managed only when the live global definitions are
  // exactly the generation registered through this managed entry.
  let definitionsMatch = published.size === 0
  if (!definitionsMatch && typeof entry.getDefinition === 'function') {
    try {
      definitionsMatch = [...published].every(name => (
        entry.getDefinition(name) === managed.publishedTools.get(name)
      ))
    } catch {
      definitionsMatch = false
    }
  }
  return sameSet(passivePayload, published) && (published.size === 0 || definitionsMatch)
    ? { available: true, kind: 'managed' }
    : { available: true, kind: 'collision' }
}

function getRouterEntryStatus(adapter, entry) {
  const registry = registries.get(adapter.identity)
  if (registry === undefined) return { available: false, kind: 'unavailable' }
  return getRouterEntryStatusByRegistry(registry, entry)
}

function managedRecordForDefinition(registry, adapter, definition) {
  for (const record of registry.entries.values()) {
    if (record.adapter === adapter && definition.name.startsWith(`mcp__${record.entry.serverName}__`)) return record
  }
  return undefined
}

function registerRouterCompatibleTool(adapter, definition) {
  const registry = registries.get(adapter.identity)
  if (registry !== undefined) requireOrphanCleanup(registry)
  if (definition.name !== ROUTER_TOOL_NAME) {
    const managed = registry === undefined ? undefined : managedRecordForDefinition(registry, adapter, definition)
    const dispose = adapter.registerTool(definition)
    if (managed === undefined) return dispose

    managed.publishedTools.set(definition.name, definition)
    try {
      notifyRouterState(registry)
    } catch (error) {
      const errors = [error]
      if (managed.publishedTools.get(definition.name) === definition) managed.publishedTools.delete(definition.name)
      try { notifyRouterState(registry) } catch (rollbackNotificationError) { errors.push(rollbackNotificationError) }
      const cleanupError = disposeOrphan(registry, dispose)
      if (cleanupError !== undefined) errors.push(cleanupError)
      maybeDeleteRegistry(registry)
      throw errorFromList(errors, 'managed tool provenance registration failed')
    }
    let disposed = false
    let provenanceRemoved = false
    return () => {
      if (disposed) return
      const errors = []
      if (!provenanceRemoved) {
        provenanceRemoved = true
        if (managed.publishedTools.get(definition.name) === definition) managed.publishedTools.delete(definition.name)
        try { notifyRouterState(registry) } catch (error) { errors.push(error) }
      }
      const cleanupError = disposeOrphan(registry, dispose)
      if (cleanupError !== undefined) errors.push(cleanupError)
      else disposed = true
      maybeDeleteRegistry(registry)
      const failure = errorFromList(errors, 'managed tool provenance disposal failed')
      if (failure !== undefined) throw failure
    }
  }
  if (registry === undefined) return adapter.registerTool(definition)
  if (registry.nativeOwner !== undefined) throw new Error(`duplicate tool: ${ROUTER_TOOL_NAME}`)

  const owner = {
    adapter,
    entryRecord: [...registry.entries.values()].find((record) => record.adapter === adapter),
    dispose: undefined,
    disposed: false
  }
  registry.nativeOwner = owner
  try {
    unpublishSharedRouter(registry)
    owner.dispose = adapter.registerTool(definition)
  } catch (error) {
    registry.nativeOwner = undefined
    let failure = error
    try { publishSharedRouter(registry) } catch (restoreError) {
      failure = combineErrors(failure, restoreError, 'native router handoff and shared-router restoration failed')
    }
    throw failure
  }

  return () => {
    releaseNativeOwner(registry, owner)
  }
}

function registerRouterServer(adapter, entry) {
  let registry = registries.get(adapter.identity)
  if (registry !== undefined) requireOrphanCleanup(registry)
  if (registry?.entries.has(entry.serverName)) {
    throw new Error(`router server "${entry.serverName}" is already registered`)
  }

  if (registry === undefined) registry = createRegistry(adapter.identity)

  const record = { adapter, entry, publishedTools: new Map() }
  registry.entries.set(entry.serverName, record)
  try {
    publishSharedRouter(registry, record)
  } catch (error) {
    registry.entries.delete(entry.serverName)
    maybeDeleteRegistry(registry)
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) {
      retryRetainedCleanup(registry, 'server retained cleanup failed')
      return
    }
    disposed = true
    let failure

    if (registry.entries.get(entry.serverName) === record) {
      registry.entries.delete(entry.serverName)

      if (registry.nativeOwner?.entryRecord === record) {
        try { releaseNativeOwner(registry, registry.nativeOwner) } catch (error) { failure = error }
      } else if (registry.sharedPublication?.owner === record) {
        try {
          unpublishSharedRouter(registry)
        } catch (error) {
          failure = error
        }
        if (hasRouterSource(registry)) {
          try { publishSharedRouter(registry) } catch (restoreError) {
            failure = combineErrors(failure, restoreError, 'shared-router owner disposal and transfer failed')
          }
        }
      }

      if (!hasRouterSource(registry) && registry.nativeOwner === undefined) {
        if (registry.sharedPublication !== undefined) {
          try { unpublishSharedRouter(registry) } catch (error) {
            failure = combineErrors(failure, error, 'final shared-router disposal failed')
          }
        }
      }
    }
    failure = combineErrors(
      failure,
      errorFromList(retryOrphanDisposers(registry), 'server retained cleanup failed'),
      'router server disposal and retained cleanup failed'
    )
    maybeDeleteRegistry(registry)
    if (failure !== undefined) throw failure
  }
}

function registerRouterVisibility(adapter, controller) {
  let registry = registries.get(adapter.identity)
  if (registry !== undefined) requireOrphanCleanup(registry)
  if (registry?.visibility !== undefined) {
    throw new Error('router visibility controller is already registered')
  }

  if (registry === undefined) registry = createRegistry(adapter.identity)
  const visibility = { adapter, controller }
  registry.visibility = visibility
  try {
    publishSharedRouter(registry, visibility)
  } catch (error) {
    registry.visibility = undefined
    maybeDeleteRegistry(registry)
    throw error
  }

  let disposed = false
  const disposeVisibility = () => {
    if (disposed) {
      retryRetainedCleanup(registry, 'visibility retained cleanup failed')
      return
    }
    disposed = true
    let failure

    if (registry.visibility === visibility) {
      registry.visibility = undefined

      if (registry.sharedPublication?.owner === visibility) {
        try {
          unpublishSharedRouter(registry)
        } catch (error) {
          failure = error
        }
        if (hasRouterSource(registry)) {
          try { publishSharedRouter(registry) } catch (restoreError) {
            failure = combineErrors(failure, restoreError, 'visibility-router owner disposal and transfer failed')
          }
        }
      }

      if (!hasRouterSource(registry) && registry.nativeOwner === undefined) {
        if (registry.sharedPublication !== undefined) {
          try { unpublishSharedRouter(registry) } catch (error) {
            failure = combineErrors(failure, error, 'final shared-router disposal failed')
          }
        }
      }
    }
    failure = combineErrors(
      failure,
      errorFromList(retryOrphanDisposers(registry), 'visibility retained cleanup failed'),
      'router visibility disposal and retained cleanup failed'
    )
    maybeDeleteRegistry(registry)
    if (failure !== undefined) throw failure
  }
  disposeVisibility.transferTo = (nextAdapter) => {
    if (disposed || registry.visibility !== visibility) throw new Error('router visibility controller is disposed')
    requireOrphanCleanup(registry)
    if (nextAdapter === visibility.adapter) return
    const publication = registry.sharedPublication
    if (publication?.owner !== visibility) {
      visibility.adapter = nextAdapter
      notifyRouterState(registry)
      return
    }

    // Keep logical availability stable during this synchronous hand-off. If the
    // replacement publication fails, the final notification makes agents fail open.
    let failure
    try { unpublishSharedRouter(registry, { notify: false }) } catch (error) { failure = error }
    visibility.adapter = nextAdapter
    try {
      publishSharedRouter(registry, visibility)
    } catch (error) {
      failure = combineErrors(failure, error, 'visibility router ownership transfer failed')
      notifyRouterState(registry)
      throw failure
    }
    if (failure !== undefined) throw failure
  }
  return disposeVisibility
}

export {
  ROUTER_TOOL_NAME,
  getRouterEntryStatus,
  registerRouterCompatibleTool,
  registerRouterServer,
  registerRouterVisibility,
  selectRoute
}
