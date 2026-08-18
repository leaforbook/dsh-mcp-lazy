const REQUIRED_CAPABILITIES = [
  ['ctx.tools.register', (ctx) => ctx?.tools?.register],
  ['ctx.on', (ctx) => ctx?.on],
  ['ctx.effect', (ctx) => ctx?.effect]
]
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const CORDIS_IDENTITY_TOKENS = new WeakMap()

function resolveServiceIdentity(tools) {
  let original
  try {
    original = tools[CORDIS_ORIGINAL]
  } catch {
    return tools
  }
  const validOriginal = original !== null &&
    (typeof original === 'object' || typeof original === 'function')
  if (!validOriginal || original === tools) return tools

  let identity = CORDIS_IDENTITY_TOKENS.get(original)
  if (identity === undefined) {
    identity = Object.create(null)
    CORDIS_IDENTITY_TOKENS.set(original, identity)
  }
  return identity
}

function createDshAdapter(ctx) {
  const missing = REQUIRED_CAPABILITIES
    .filter(([, read]) => typeof read(ctx) !== 'function')
    .map(([name]) => name)
  if (missing.length > 0) {
    const reason = `unsupported DSH host; missing capabilities: ${missing.join(', ')}`
    ctx?.logger?.error?.(`mcp-lazy: ${reason}`)
    return { supported: false, reason }
  }
  return {
    supported: true,
    identity: resolveServiceIdentity(ctx.tools),
    registerTool: (definition) => ctx.tools.register(definition),
    on: (event, handler) => ctx.on(event, handler),
    effect: (factory, label) => ctx.effect(factory, label),
    log(level, message) {
      const logger = ctx.logger
      const method = typeof logger?.[level] === 'function' ? level : 'info'
      logger?.[method]?.(message)
    }
  }
}

export { createDshAdapter }
