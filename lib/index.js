// 按需激活的 MCP 桥接插件（@xiaoyilin/dsh-mcp-lazy）
//
// 与 @deepseek-ai/dsh-mcp-client 的差异：
//   1. 启动时不连接 MCP 服务器，只注册两个轻量控制工具：
//      mcp__<serverName>__activate   —— 连接服务器并注册其全部工具
//      mcp__<serverName>__deactivate —— 断开连接并卸载已注册工具
//   2. 每轮按需（默认 releaseOnTurnEnd: true）：某个会话在本轮激活服务器后，
//      本轮对话结束（agent/turn-stopping）且没有任何会话仍在当轮使用它时，
//      立即卸载全部工具；保温期内下一轮可复用连接，超时后自动断开。
//      agent/disposed（会话销毁）作为兜底释放路径始终生效。
//   3. 工具命名、调用、结果投影等协议与 mcp-client 完全一致（复用同一套
//      实现约定），保证模型看到的工具形态不变。
//   4. 工具目录变更采用先发现、后差量替换；失败时保留最后一次可用目录。
//   5. 连接意外断开时立即卸载工具；仍有活跃使用者时仅做有限次数自动重连。
import z from '@deepseek-ai/schemastery'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { z as zod } from 'zod'
import {
  discoverTools,
  fingerprintTool
} from './lazy-core.js'
import { createDshAdapter } from './dsh-adapter.js'
import { createServerRuntime } from './server-runtime.js'
import { registerRouterCompatibleTool, registerRouterServer } from './tool-router.js'

const require = createRequire(import.meta.url)
const { version: pluginVersion } = require('../package.json')

const name = 'mcp-lazy'
const inject = ['tools']

const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
const DEFAULT_CONNECT_TIMEOUT_MS = 30000
const DEFAULT_DISCOVERY_TIMEOUT_MS = 60000
const DEFAULT_MAX_TOOL_LIST_PAGES = 100
const DEFAULT_RECONNECT_ATTEMPTS = 1
const DEFAULT_WARM_IDLE_MS = 300000
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
    connectTimeoutMs: z.number().default(DEFAULT_CONNECT_TIMEOUT_MS),
    discoveryTimeoutMs: z.number().default(DEFAULT_DISCOVERY_TIMEOUT_MS),
    maxToolListPages: z.number().default(DEFAULT_MAX_TOOL_LIST_PAGES),
    reconnectAttempts: z.number().default(DEFAULT_RECONNECT_ATTEMPTS),
    autoActivate: z.boolean().default(false),
    releaseOnTurnEnd: z.boolean().default(true),
    warmIdleMs: z.number().default(DEFAULT_WARM_IDLE_MS),
    routingHints: z.array(String).default([])
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    connectTimeoutMs: z.number().default(DEFAULT_CONNECT_TIMEOUT_MS),
    discoveryTimeoutMs: z.number().default(DEFAULT_DISCOVERY_TIMEOUT_MS),
    maxToolListPages: z.number().default(DEFAULT_MAX_TOOL_LIST_PAGES),
    reconnectAttempts: z.number().default(DEFAULT_RECONNECT_ATTEMPTS),
    autoActivate: z.boolean().default(false),
    releaseOnTurnEnd: z.boolean().default(true),
    warmIdleMs: z.number().default(DEFAULT_WARM_IDLE_MS),
    routingHints: z.array(String).default([])
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

function createExecutor(client, rawName, taskRequired, timeoutMs, onUse, onSuccess) {
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
      onSuccess?.(exec.agent)
      return {
        content: [{ type: 'text', text }],
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {})
      }
    }
    const content = result.content
    const text = extractText(content, rawName)
    if (result.isError === true) throw new Error(text)
    onSuccess?.(exec.agent)
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
  // DSH may auto-insert an installed plugin once without instance config.
  // Explicit entries from cordis.patch.yml are applied separately with config.
  if (config === undefined) return

  const adapter = createDshAdapter(ctx)
  if (!adapter.supported) return

  const label = `mcp-lazy(${config.serverName})`
  const connectTimeoutMs = positiveInteger(config.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS)
  const discoveryTimeoutMs = positiveInteger(config.discoveryTimeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS)
  const maxToolListPages = positiveInteger(config.maxToolListPages, DEFAULT_MAX_TOOL_LIST_PAGES)
  const reconnectAttempts = nonNegativeInteger(config.reconnectAttempts, DEFAULT_RECONNECT_ATTEMPTS)
  const warmIdleMs = nonNegativeInteger(config.warmIdleMs, DEFAULT_WARM_IDLE_MS)

  let runtime

  async function discoverDefinitions(client, signal) {
    const tools = await discoverTools({
      request: client.request.bind(client),
      resultSchema: ListToolsResultSchema,
      timeoutMs: discoveryTimeoutMs,
      maxPages: maxToolListPages,
      signal
    })
    const definitions = new Map()
    for (const tool of tools) {
      const publicName = publicToolName(config.serverName, tool.name)
      if (definitions.has(publicName)) {
        throw new Error(`${label}: multiple MCP tool names map to public name "${publicName}"`)
      }
      definitions.set(publicName, {
        fingerprint: fingerprintTool(tool),
        summary: { name: publicName, description: tool.description ?? '' },
        definition: {
          name: publicName,
          description: tool.description ?? '',
          parameters: tool.inputSchema,
          output: createOutput(tool.name, supportedOutputSchema(tool.outputSchema)),
          execute: createExecutor(
            client,
            tool.name,
            tool.execution?.taskSupport === 'required',
            config.toolCallTimeoutMs,
            runtime.addUser,
            runtime.markSuccessfulUse
          )
        }
      })
    }
    return definitions
  }

  async function createConnectedClient(signal, callbacks) {
    const client = new Client({ name: 'dsh-mcp-lazy', version: pluginVersion }, { capabilities: {} })
    client.onclose = () => callbacks.onClose(client)
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => callbacks.onToolsChanged(client))
    try {
      await client.connect(buildTransport(config), { timeout: connectTimeoutMs, signal })
      return client
    } catch (error) {
      void client.close().catch(() => {})
      throw error
    }
  }

  const runtimeAdapter = {
    ...adapter,
    registerTool: (definition) => registerRouterCompatibleTool(adapter, definition)
  }

  runtime = createServerRuntime({
    adapter: runtimeAdapter,
    config: { ...config, warmIdleMs },
    label,
    reconnectAttempts,
    createConnectedClient,
    discoverDefinitions
  })

  const setupDisposers = []
  let activationPromise
  let cleanupPromise

  function retainDisposer(dispose) {
    if (typeof dispose === 'function') setupDisposers.push(dispose)
  }

  function cleanup() {
    if (cleanupPromise !== undefined) return cleanupPromise
    for (const dispose of setupDisposers.splice(0).reverse()) {
      try { dispose() } catch (error) { adapter.log('warn', `${label}: setup disposal failed: ${String(error)}`) }
    }
    cleanupPromise = Promise.resolve(runtime.dispose())
      .catch((error) => adapter.log('error', `${label}: plugin disposal failed: ${String(error)}`))
    return cleanupPromise
  }

  try {
    retainDisposer(registerRouterServer(adapter, {
      serverName: config.serverName,
      routingHints: config.routingHints ?? [],
      getCatalog: runtime.getCatalog,
      activate: (agent, signal) => runtime.activate(agent, false, signal)
    }))

    retainDisposer(adapter.on('agent/turn-stopping', runtime.onTurnStopping))
    retainDisposer(adapter.on('agent/disposed', runtime.onAgentDisposed))

    retainDisposer(adapter.registerTool({
      name: `mcp__${config.serverName}__activate`,
      description: `按需激活 MCP 服务器 "${config.serverName}"：连接该服务器并把它提供的全部工具注册进工具目录，立即可用${config.releaseOnTurnEnd ? '（本轮结束后自动卸载）' : ''}。调用任何 mcp__${config.serverName}__* 工具之前必须先调用本工具；重复调用是安全的。`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: ACTIVATE_TOOL_TIMEOUT_MS,
      output: textOutput(),
      execute: async (_args, exec) => ({ content: [{ type: 'text', text: await runtime.activate(exec.agent, false, exec.signal) }] })
    }))

    retainDisposer(adapter.registerTool({
      name: `mcp__${config.serverName}__deactivate`,
      description: `立即停用 MCP 服务器 "${config.serverName}"：断开连接并把它的全部工具从工具目录中卸载，以节省上下文 token。`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: DEACTIVATE_TOOL_TIMEOUT_MS,
      output: textOutput(),
      execute: async () => ({ content: [{ type: 'text', text: await runtime.deactivate() }] })
    }))

    adapter.effect(() => {
      activationPromise = config.autoActivate ? runtime.activate(undefined, true) : null
      return cleanup
    }, 'mcp-lazy.state')
  } catch (error) {
    await cleanup()
    void activationPromise
    throw error
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

export { Config, apply, inject, name }
