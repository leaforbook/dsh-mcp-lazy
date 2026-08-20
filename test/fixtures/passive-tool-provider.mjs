const output = {
  schema: {
    type: 'object',
    properties: { content: { type: 'array', items: {} }, structuredContent: {} },
    required: ['content', 'structuredContent'],
    additionalProperties: false
  },
  render(_args, value) {
    return value.content
  }
}

const counters = new Map()

function apply(ctx, config) {
  const prefix = config.conforming ? `mcp__${config.serverName}__` : 'mcp_fixture_nonconforming_'
  const disposers = ['echo', 'counter'].map(rawName => ctx.tools.register({
    name: `${prefix}${rawName}`,
    description: `${config.serverName} acceptance ${rawName}`,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: false
    },
    output,
    async execute(args) {
      const count = config.counter
        ? (config.counter.value += 1)
        : (counters.set(config.serverName, (counters.get(config.serverName) ?? 0) + 1), counters.get(config.serverName))
      return {
        content: [{ type: 'text', text: args.text ?? rawName }],
        structuredContent: { provider: config.serverName, rawName, count }
      }
    }
  }))
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) dispose()
  }, `fixture.${config.serverName}`)
}

export { apply }
