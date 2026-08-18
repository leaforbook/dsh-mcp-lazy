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

function registerRouterServer(adapter, entry) {
  let registry = registries.get(adapter.identity)
  if (registry?.entries.has(entry.serverName)) {
    throw new Error(`router server "${entry.serverName}" is already registered`)
  }

  if (registry === undefined) {
    registry = { entries: new Map(), dispose: undefined }
    registries.set(adapter.identity, registry)
    try {
      registry.dispose = adapter.registerTool({
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
      })
    } catch (error) {
      registries.delete(adapter.identity)
      throw error
    }
  }

  registry.entries.set(entry.serverName, entry)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    registry.entries.delete(entry.serverName)
    if (registry.entries.size === 0) {
      registry.dispose?.()
      registries.delete(adapter.identity)
    }
  }
}

export { ROUTER_TOOL_NAME, registerRouterServer, selectRoute }
