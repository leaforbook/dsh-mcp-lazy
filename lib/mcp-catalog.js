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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    )
  }
  return value
}

function stableSchemaFingerprint(schema) {
  const serialized = JSON.stringify(canonicalize(schema))
  return serialized === undefined ? 'undefined' : serialized
}

function snapshot(value) {
  if (Array.isArray(value)) return value.map(snapshot)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map(key => [key, snapshot(value[key])]))
  }
  return value
}

function buildMcpCatalog({ schemas, getDefinition, routerName }) {
  const groups = new Map()
  const passthrough = new Set()
  const sortedSchemas = [...(schemas ?? [])]
    .filter(schema => schema && typeof schema.name === 'string')
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

  for (const schema of sortedSchemas) {
    if (schema.name === routerName) continue
    const parsed = parseMcpPublicName(schema.name)
    if (parsed === undefined) continue
    const entry = {
      name: schema.name,
      description: snapshot(schema.description),
      parameters: snapshot(schema.parameters)
    }
    let group = groups.get(parsed.serverName)
    if (group === undefined) {
      group = { entries: [], unresolved: false }
      groups.set(parsed.serverName, group)
    }
    group.entries.push(entry)
    if (getDefinition(schema.name)?.name !== schema.name) group.unresolved = true
  }

  const servers = new Map()
  const admitted = []
  for (const [serverName, group] of groups) {
    if (group.unresolved) {
      for (const entry of group.entries) passthrough.add(entry.name)
      continue
    }
    const entries = group.entries
    const toolNames = entries.map(entry => entry.name)
    const catalogEntries = entries.map(entry => ({ name: entry.name, description: entry.description }))
    servers.set(serverName, {
      serverName,
      toolNames,
      getCatalog: () => catalogEntries.map(entry => ({ ...entry }))
    })
    for (const entry of entries) {
      admitted.push([entry.name, stableSchemaFingerprint({ description: entry.description, parameters: entry.parameters })])
    }
  }

  admitted.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
  const signature = stableSchemaFingerprint({ admitted, passthrough: [...passthrough].sort() })
  return { signature, servers, passthrough }
}

export { buildMcpCatalog, parseMcpPublicName, stableSchemaFingerprint }
