const REQUIRED_CAPABILITIES = [
  ['ctx.tools.register', (ctx) => ctx?.tools?.register],
  ['ctx.on', (ctx) => ctx?.on],
  ['ctx.effect', (ctx) => ctx?.effect]
]
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

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
    identity: ctx.tools[CORDIS_ORIGINAL] ?? ctx.tools,
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
