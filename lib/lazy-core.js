import { createHash } from 'node:crypto'

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function fingerprintTool(tool) {
  return createHash('sha256').update(canonicalJson(tool)).digest('hex')
}

async function discoverTools({ request, resultSchema, timeoutMs, maxPages, signal }) {
  const tools = []
  const names = new Set()
  const cursors = new Set()
  let cursor

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await request({
      method: 'tools/list',
      ...(cursor === undefined ? {} : { params: { cursor } })
    }, resultSchema, {
      timeout: timeoutMs,
      ...(signal === undefined ? {} : { signal })
    })
    for (const tool of response.tools) {
      if (names.has(tool.name)) throw new Error(`server listed tool "${tool.name}" more than once — invalid tool list`)
      names.add(tool.name)
      tools.push(tool)
    }
    if (response.nextCursor === undefined) return tools
    if (cursors.has(response.nextCursor)) {
      throw new Error(`repeated tools/list cursor: ${response.nextCursor}`)
    }
    cursors.add(response.nextCursor)
    cursor = response.nextCursor
  }

  throw new Error(`exceeded ${maxPages} tools/list pages`)
}

function reconcileRegistrations(current, next, register) {
  const additions = []
  const changes = []
  const unchanged = new Map()

  for (const [name, candidate] of next) {
    const existing = current.get(name)
    if (existing === undefined) additions.push([name, candidate])
    else if (existing.fingerprint === candidate.fingerprint) unchanged.set(name, existing)
    else changes.push([name, existing, candidate])
  }

  const added = new Map()
  try {
    for (const [name, candidate] of additions) {
      added.set(name, { ...candidate, dispose: register(candidate.definition) })
    }
  } catch (error) {
    for (const entry of added.values()) entry.dispose()
    throw error
  }

  const changed = new Map()
  const completedChanges = []
  try {
    for (const [name, existing, candidate] of changes) {
      existing.dispose()
      try {
        const replacement = { ...candidate, dispose: register(candidate.definition) }
        changed.set(name, replacement)
        completedChanges.push([name, existing, replacement])
      } catch (error) {
        current.set(name, { ...existing, dispose: register(existing.definition) })
        throw error
      }
    }
  } catch (error) {
    for (const [name, existing, replacement] of completedChanges.reverse()) {
      replacement.dispose()
      current.set(name, { ...existing, dispose: register(existing.definition) })
    }
    for (const entry of added.values()) entry.dispose()
    throw error
  }

  for (const [name, existing] of current) {
    if (!next.has(name)) existing.dispose()
  }

  const result = new Map()
  for (const name of [...next.keys()].sort(compareText)) {
    result.set(name, unchanged.get(name) ?? changed.get(name) ?? added.get(name))
  }
  return result
}

function createRefreshCoordinator(refresh) {
  let requestedGeneration = 0
  let completedGeneration = 0
  let flight = null

  function startFlight() {
    const state = { generation: 0, error: undefined, promise: undefined }
    state.promise = Promise.resolve().then(async () => {
      state.generation = requestedGeneration
      try {
        await refresh()
      } catch (error) {
        state.error = error
      } finally {
        completedGeneration = Math.max(completedGeneration, state.generation)
      }
    }).finally(() => {
      if (flight === state) flight = null
    })
    flight = state
    return state
  }

  return {
    async request() {
      const targetGeneration = ++requestedGeneration
      while (completedGeneration < targetGeneration) {
        const current = flight ?? startFlight()
        await current.promise
        if (current.error !== undefined && targetGeneration <= current.generation) throw current.error
      }
    }
  }
}

export {
  createRefreshCoordinator,
  discoverTools,
  fingerprintTool,
  reconcileRegistrations
}
