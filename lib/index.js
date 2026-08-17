// 按需激活的 MCP 桥接插件（@xiaoyilin/dsh-mcp-lazy）
//
// 与 @deepseek-ai/dsh-mcp-client 的差异：
//   1. 启动时不连接 MCP 服务器，只注册两个轻量控制工具：
//      mcp__<serverName>__activate   —— 连接服务器并注册其全部工具
//      mcp__<serverName>__deactivate —— 断开连接并卸载已注册工具
//   2. 每轮按需（默认 releaseOnTurnEnd: true）：某个会话在本轮激活服务器后，
//      本轮对话结束（agent/turn-stopping）且没有任何会话仍在当轮使用它时，
//      自动断开并卸载全部工具——下一轮重新激活即可。
//      agent/disposed（会话销毁）作为兜底释放路径始终生效。
//   3. 工具命名、调用、结果投影等协议与 mcp-client 完全一致（复用同一套
//      实现约定），保证模型看到的工具形态不变。
//   4. 连接意外断开时自动卸载工具并打日志；模型重新调用 activate 即可恢复。
//      不做自动重连（按需模式下重连属于多余开销）。
import z from '@deepseek-ai/schemastery'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { z as zod } from 'zod'

const name = 'mcp-lazy'
const inject = ['tools']

const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
const ACTIVATE_TOOL_TIMEOUT_MS = 180000
const DEACTIVATE_TOOL_TIMEOUT_MS = 60000

const RawCallToolResultSchema = zod.record(zod.string(), zod.unknown())

// 与 mcp-client 相同的公共名规范化：DeepSeek 函数名契约（64 字符、[A-Za-z0-9_-]），
// 规范化有损时追加 12 位十六进制哈希保证不冲突。
function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

const ServerConfig = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    autoActivate: z.boolean().default(false),
    releaseOnTurnEnd: z.boolean().default(true)
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    autoActivate: z.boolean().default(false),
    releaseOnTurnEnd: z.boolean().default(true)
  })
])

const Config = ServerConfig

function buildTransport(config) {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...scrubbedParentEnv(), ...config.env },
        cwd: config.cwd || undefined
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
  }
}

function supportedOutputSchema(candidate) {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate
  } catch {
    return undefined
  }
}

function createOutput(rawName, structuredSchema) {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {}
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false
    },
    render(_args, value) {
      return [{ type: 'text', text: extractText(value.content, rawName) }]
    }
  }
}

function extractText(mcpContent, toolName) {
  const parts = []
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    const block = value
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) parts.push(block.text)
        break
      case 'image':
        parts.push(`[image: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${block.type}]`)
    }
  }
  return parts.join('\n') || `(${toolName} returned no text content)`
}

function createExecutor(client, rawName, taskRequired, timeoutMs, onUse) {
  return async (args, exec) => {
    onUse?.(exec.agent)
    if (taskRequired) throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`)
    const result = await client.request({
      method: 'tools/call',
      params: { name: rawName, arguments: typeof args === 'object' && args !== null ? args : {} }
    }, RawCallToolResultSchema, {
      signal: exec.signal,
      timeout: timeoutMs
    })
    if (!Array.isArray(result.content)) {
      const rendered = 'toolResult' in result ? JSON.stringify(result.toolResult) : '(no output)'
      const text = typeof rendered === 'string' ? rendered : '(no output)'
      if (result.isError === true) throw new Error(text)
      return {
        content: [{ type: 'text', text }],
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {})
      }
    }
    const content = result.content
    const text = extractText(content, rawName)
    if (result.isError === true) throw new Error(text)
    return {
      content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {})
    }
  }
}

// 控制工具的结果输出：文本块投影。
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

async function apply(ctx, config) {
  const label = `mcp-lazy(${config.serverName})`

  // ---- 单实例状态 ----
  let client // 已连接的 MCP Client；未激活时为 undefined
  let disposers = new Map() // 当前注册的工具名 -> 注销函数
  let activation = null // 进行中的激活 Promise（防止并发重复激活）
  let users = new Set() // 本轮激活/使用过该服务器的 agent（用于轮末自动释放判断）

  function addUser(agent) {
    if (agent) users.add(agent)
  }

  async function syncTools(gen) {
    const definitions = new Map()
    let cursor
    do {
      const response = await gen.request({
        method: 'tools/list',
        ...(cursor === undefined ? {} : { params: { cursor } })
      }, ListToolsResultSchema)
      for (const tool of response.tools) {
        const publicName = publicToolName(config.serverName, tool.name)
        if (definitions.has(publicName)) {
          throw new Error(`${label}: server listed tool "${tool.name}" more than once — invalid tool list`)
        }
        definitions.set(publicName, {
          name: publicName,
          description: tool.description ?? '',
          parameters: tool.inputSchema,
          output: createOutput(tool.name, supportedOutputSchema(tool.outputSchema)),
          execute: createExecutor(gen, tool.name, tool.execution?.taskSupport === 'required', config.toolCallTimeoutMs, addUser)
        })
      }
      cursor = response.nextCursor
    } while (cursor)
    const next = new Map()
    try {
      for (const [publicName, definition] of definitions) next.set(publicName, ctx.tools.register(definition))
    } catch (error) {
      for (const dispose of next.values()) dispose()
      ctx.logger.error(`${label}: tool registration failed, no tools registered: ${String(error)}`)
      throw error
    }
    return next
  }

  async function activate(agent) {
    addUser(agent)
    if (client) return `MCP 服务器 "${config.serverName}" 已处于激活状态（${disposers.size} 个工具在线），无需重复激活。`
    if (activation) return activation
    activation = (async () => {
      const gen = new Client({ name: 'dsh-mcp-lazy', version: '0.2.0' }, { capabilities: {} })
      gen.onclose = () => {
        if (client !== gen) return
        client = undefined
        const count = disposers.size
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
        users.clear()
        ctx.logger.warn(`${label}: 连接已断开，${count} 个工具已卸载；再次调用 mcp__${config.serverName}__activate 可重新激活`)
      }
      gen.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (client !== gen) return
        ctx.logger.info(`${label}: tool list changed, re-syncing`)
        try {
          const old = disposers
          for (const dispose of old.values()) dispose()
          disposers = await syncTools(gen)
        } catch (error) {
          disposers = new Map()
          ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`)
        }
      })
      try {
        await gen.connect(buildTransport(config))
        const next = await syncTools(gen)
        client = gen
        disposers = next
        const names = [...next.keys()].sort()
        ctx.logger.info(`${label}: 已激活，注册 ${names.length} 个工具`)
        return `已激活 MCP 服务器 "${config.serverName}"，共 ${names.length} 个工具（本轮对话结束后将自动卸载）：\n` +
          names.map((n) => `- ${n}`).join('\n')
      } catch (error) {
        try { await gen.close() } catch {}
        ctx.logger.error(`${label}: 激活失败: ${String(error)}`)
        return `激活 "${config.serverName}" 失败：${String(error)}`
      } finally {
        activation = null
      }
    })()
    return activation
  }

  async function deactivate(reason) {
    if (activation) {
      try { await activation } catch {}
    }
    if (!client) {
      users.clear()
      return `MCP 服务器 "${config.serverName}" 当前未激活，无需停用。`
    }
    const gen = client
    client = undefined
    try { await gen.close() } catch (error) { ctx.logger.warn(`${label}: close failed: ${String(error)}`) }
    const count = disposers.size
    for (const dispose of disposers.values()) dispose()
    disposers = new Map()
    users.clear()
    if (reason) {
      ctx.logger.info(`${label}: ${reason}，${count} 个工具已自动卸载`)
      return `已停用 MCP 服务器 "${config.serverName}"（${reason}），其 ${count} 个工具已从工具目录中卸载。`
    }
    ctx.logger.info(`${label}: 已停用，${count} 个工具已卸载`)
    return `已停用 MCP 服务器 "${config.serverName}"，其 ${count} 个工具已从工具目录中卸载。`
  }

  // ---- 每轮自动释放：某个 agent 的轮次结束时，从使用集合中移除它；----
  // ---- 集合为空则断开连接、卸载工具（多会话/子代理并发使用时不会误杀）。----
  function maybeRelease(reason) {
    if (users.size === 0 && client !== undefined) {
      void deactivate(reason).catch((error) => ctx.logger.error(`${label}: 自动释放失败: ${String(error)}`))
    }
  }

  ctx.on('agent/turn-stopping', (payload) => {
    if (!config.releaseOnTurnEnd) return
    const before = users.size
    users.delete(payload?.agent)
    if (users.size !== before) maybeRelease('本轮对话结束，无会话继续使用')
  })

  ctx.on('agent/disposed', (payload) => {
    const before = users.size
    users.delete(payload?.agent)
    if (users.size !== before) maybeRelease('会话已销毁')
  })

  ctx.effect(() => {
    const activationPromise = config.autoActivate ? activate() : null
    return () => {
      const gen = client
      client = undefined
      if (gen !== undefined) {
        gen.close().catch(() => {})
      }
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
      users.clear()
      activation = null
      void activationPromise
    }
  }, 'mcp-lazy.state')

  ctx.tools.register({
    name: `mcp__${config.serverName}__activate`,
    description: `按需激活 MCP 服务器 "${config.serverName}"：连接该服务器并把它提供的全部工具注册进工具目录，本轮对话内立即可用（本轮结束后自动卸载）。调用任何 mcp__${config.serverName}__* 工具之前必须先调用本工具；重复调用是安全的。`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: ACTIVATE_TOOL_TIMEOUT_MS,
    output: textOutput(),
    execute: async (_args, exec) => ({ content: [{ type: 'text', text: await activate(exec.agent) }] })
  })

  ctx.tools.register({
    name: `mcp__${config.serverName}__deactivate`,
    description: `立即停用 MCP 服务器 "${config.serverName}"：断开连接并把它的全部工具从工具目录中卸载，以节省上下文 token。`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: DEACTIVATE_TOOL_TIMEOUT_MS,
    output: textOutput(),
    execute: async () => ({ content: [{ type: 'text', text: await deactivate() }] })
  })
}

export { Config, apply, inject, name }
