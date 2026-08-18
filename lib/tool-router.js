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

function selectRoute(entries, { query, serverName } = {}) {
  const sorted = [...entries].sort((left, right) => left.serverName.localeCompare(right.serverName))
  if (serverName) return { entry: sorted.find((item) => item.serverName === serverName), candidates: [] }
  const prefix = normalized(query).match(/mcp__([a-z0-9_-]{1,32})__/i)?.[1]
  if (prefix) return { entry: sorted.find((item) => normalized(item.serverName) === prefix), candidates: [] }
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

function publishSharedRouter(registry) {
  if (registry.dispose !== undefined || registry.nativeOwner !== undefined || registry.entries.size === 0) return
  registry.dispose = registry.adapter.registerTool(registry.definition)
}

function unpublishSharedRouter(registry) {
  if (registry.dispose === undefined) return
  const dispose = registry.dispose
  registry.dispose = undefined
  dispose()
}

function registerRouterCompatibleTool(adapter, definition) {
  if (definition.name !== ROUTER_TOOL_NAME) return adapter.registerTool(definition)
  const registry = registries.get(adapter.identity)
  if (registry === undefined) return adapter.registerTool(definition)
  if (registry.nativeOwner !== undefined) throw new Error(`duplicate tool: ${ROUTER_TOOL_NAME}`)

  const owner = {}
  registry.nativeOwner = owner
  unpublishSharedRouter(registry)
  let disposeNative
  try {
    disposeNative = adapter.registerTool(definition)
  } catch (error) {
    registry.nativeOwner = undefined
    publishSharedRouter(registry)
    throw error
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposeNative()
    disposed = true
    if (registry.nativeOwner !== owner) return
    registry.nativeOwner = undefined
    if (registry.entries.size === 0) registries.delete(adapter.identity)
    else publishSharedRouter(registry)
  }
}

function registerRouterServer(adapter, entry) {
  let registry = registries.get(adapter.identity)
  if (registry?.entries.has(entry.serverName)) {
    throw new Error(`router server "${entry.serverName}" is already registered`)
  }

  if (registry === undefined) {
    registry = {
      adapter,
      definition: undefined,
      dispose: undefined,
      entries: new Map(),
      nativeOwner: undefined
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
        const route = selectRoute(registry.entries.values(), args)
        if (route.entry !== undefined) {
          const result = await route.entry.activate(exec.agent, exec.signal)
          return {
            content: [{ type: 'text', text: `已选择 MCP 服务器 "${route.entry.serverName}"：${result}` }]
          }
        }
        return { content: [{ type: 'text', text: candidateSummary(route.candidates) }] }
      }
    }
    registries.set(adapter.identity, registry)
  }

  registry.entries.set(entry.serverName, entry)
  try {
    publishSharedRouter(registry)
  } catch (error) {
    registry.entries.delete(entry.serverName)
    if (registry.entries.size === 0) registries.delete(adapter.identity)
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    registry.entries.delete(entry.serverName)
    if (registry.entries.size === 0) {
      unpublishSharedRouter(registry)
      if (registry.nativeOwner === undefined) registries.delete(adapter.identity)
    }
  }
}

export { ROUTER_TOOL_NAME, registerRouterCompatibleTool, registerRouterServer, selectRoute }
