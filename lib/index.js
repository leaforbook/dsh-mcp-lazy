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
  createRefreshCoordinator,
  discoverTools,
  fingerprintTool,
  reconcileRegistrations
} from './lazy-core.js'
import { createDshAdapter } from './dsh-adapter.js'

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
const ACTIVATE_TOOL_TIMEOUT_MS = 180000
const ACTIVATE_INTERNAL_TIMEOUT_MS = ACTIVATE_TOOL_TIMEOUT_MS - 5000
const DEACTIVATE_TOOL_TIMEOUT_MS = 60000
const RECONNECT_DELAY_MS = 100

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
    releaseOnTurnEnd: z.boolean().default(true)
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

  // ---- 单实例状态 ----
  let client // 已连接的 MCP Client；未激活时为 undefined
  let connectingClient // 正在建立连接的 MCP Client；用于插件销毁时中止连接
  let registrations = new Map() // 公共工具名 -> { definition, fingerprint, dispose }
  let activation = null // 进行中的激活 Promise（防止并发重复激活）
  let activationController
  let reconnectTimer
  let users = new Set() // 本轮激活/使用过该服务器的 agent（用于轮末自动释放判断）
  let reconnectRemaining = reconnectAttempts
  let disposed = false

  function addUser(agent) {
    if (agent) users.add(agent)
  }

  function markSuccessfulUse(agent) {
    addUser(agent)
    reconnectRemaining = reconnectAttempts
  }

  function disposeRegistrations() {
    const count = registrations.size
    for (const entry of registrations.values()) {
      try { entry.dispose() } catch (error) { ctx.logger.warn(`${label}: tool disposal failed: ${String(error)}`) }
    }
    registrations = new Map()
    return count
  }

  function wantsConnection() {
    return users.size > 0 || config.autoActivate
  }

  async function discoverDefinitions(gen, signal) {
    const tools = await discoverTools({
      request: gen.request.bind(gen),
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
        definition: {
          name: publicName,
          description: tool.description ?? '',
          parameters: tool.inputSchema,
          output: createOutput(tool.name, supportedOutputSchema(tool.outputSchema)),
          execute: createExecutor(
            gen,
            tool.name,
            tool.execution?.taskSupport === 'required',
            config.toolCallTimeoutMs,
            addUser,
            markSuccessfulUse
          )
        }
      })
    }
    return definitions
  }

  async function syncTools(gen, signal, requireDemand = false) {
    const definitions = await discoverDefinitions(gen, signal)
    if (client !== gen || disposed) return false
    if (requireDemand && !wantsConnection()) return false
    registrations = reconcileRegistrations(
      registrations,
      definitions,
      (definition) => ctx.tools.register(definition)
    )
    return true
  }

  function cancelReconnect() {
    if (reconnectTimer === undefined) return
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  function scheduleReconnect() {
    if (disposed || client || activation || reconnectTimer !== undefined || !wantsConnection() || reconnectRemaining <= 0) return
    const attempt = reconnectAttempts - reconnectRemaining + 1
    ctx.logger.warn(`${label}: 连接意外断开，准备有限自动重连（${attempt}/${reconnectAttempts}）`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (disposed || client || activation || !wantsConnection()) return
      reconnectRemaining -= 1
      void activate(undefined, true).then((message) => {
        if (client) ctx.logger.info(`${label}: 自动重连成功`)
        else {
          ctx.logger.warn(`${label}: 自动重连未成功: ${message}`)
          scheduleReconnect()
        }
      }).catch((error) => {
        ctx.logger.error(`${label}: 自动重连失败: ${String(error)}`)
        scheduleReconnect()
      })
    }, RECONNECT_DELAY_MS)
    reconnectTimer.unref?.()
  }

  async function activate(agent, automatic = false, externalSignal) {
    addUser(agent)
    if (!automatic) reconnectRemaining = reconnectAttempts
    if (client) return `MCP 服务器 "${config.serverName}" 已处于激活状态（${registrations.size} 个工具在线），无需重复激活。`
    if (activation) return activation
    if (automatic && !wantsConnection()) return `未重连 "${config.serverName}"：当前已无活跃使用者。`
    activation = (async () => {
      const activationAbort = createActivationAbort(externalSignal, ACTIVATE_INTERNAL_TIMEOUT_MS, label)
      activationController = activationAbort.controller
      const gen = new Client({ name: 'dsh-mcp-lazy', version: pluginVersion }, { capabilities: {} })
      connectingClient = gen
      gen.onclose = () => {
        if (client !== gen) return
        client = undefined
        const count = disposeRegistrations()
        ctx.logger.warn(`${label}: 连接已断开，${count} 个工具已卸载`)
        scheduleReconnect()
      }
      const refresh = createRefreshCoordinator(async () => {
        if (client !== gen || disposed) return
        const before = registrations.size
        if (await syncTools(gen)) {
          ctx.logger.info(`${label}: tool list refreshed (${before} -> ${registrations.size})`)
        }
      })
      gen.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (client !== gen) return
        try {
          await refresh.request()
        } catch (error) {
          ctx.logger.error(`${label}: tool refresh failed; keeping last good catalog: ${String(error)}`)
        }
      })
      try {
        await gen.connect(buildTransport(config), {
          timeout: connectTimeoutMs,
          signal: activationAbort.controller.signal
        })
        if (disposed) throw new Error(`${label}: plugin disposed during activation`)
        if (activationAbort.controller.signal.aborted) throw activationAbort.controller.signal.reason
        if (!wantsConnection()) throw new Error(`${label}: activation no longer needed`)
        client = gen
        if (!await syncTools(gen, activationAbort.controller.signal, true) || client !== gen) {
          throw new Error(`${label}: connection closed or activation no longer needed`)
        }
        ctx.logger.info(`${label}: 已激活，注册 ${registrations.size} 个工具`)
        const releaseNote = config.releaseOnTurnEnd ? '，本轮结束后自动卸载' : ''
        return `已激活 MCP 服务器 "${config.serverName}"（${registrations.size} 个工具${releaseNote}）。`
      } catch (error) {
        if (client === gen) client = undefined
        disposeRegistrations()
        void gen.close().catch(() => {})
        ctx.logger.error(`${label}: 激活失败: ${String(error)}`)
        return `激活 "${config.serverName}" 失败：${String(error)}`
      } finally {
        activationAbort.cleanup()
        if (activationController === activationAbort.controller) activationController = undefined
        if (connectingClient === gen) connectingClient = undefined
        activation = null
      }
    })()
    return activation
  }

  async function deactivate(reason) {
    cancelReconnect()
    activationController?.abort(new Error(`${label}: deactivated`))
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
    const count = disposeRegistrations()
    users.clear()
    reconnectRemaining = reconnectAttempts
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
    if (users.size !== 0 || config.autoActivate) return
    cancelReconnect()
    activationController?.abort(new Error(`${label}: no active users remain`))
    if (client !== undefined || activation) {
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
    const activationPromise = config.autoActivate ? activate(undefined, true) : null
    return () => {
      disposed = true
      cancelReconnect()
      activationController?.abort(new Error(`${label}: plugin disposed`))
      activationController = undefined
      const gen = client
      client = undefined
      if (gen !== undefined) gen.close().catch(() => {})
      if (connectingClient !== undefined && connectingClient !== gen) connectingClient.close().catch(() => {})
      connectingClient = undefined
      disposeRegistrations()
      users.clear()
      activation = null
      void activationPromise
    }
  }, 'mcp-lazy.state')

  ctx.tools.register({
    name: `mcp__${config.serverName}__activate`,
    description: `按需激活 MCP 服务器 "${config.serverName}"：连接该服务器并把它提供的全部工具注册进工具目录，立即可用${config.releaseOnTurnEnd ? '（本轮结束后自动卸载）' : ''}。调用任何 mcp__${config.serverName}__* 工具之前必须先调用本工具；重复调用是安全的。`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: ACTIVATE_TOOL_TIMEOUT_MS,
    output: textOutput(),
    execute: async (_args, exec) => ({ content: [{ type: 'text', text: await activate(exec.agent, false, exec.signal) }] })
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

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function createActivationAbort(externalSignal, timeoutMs, label) {
  const controller = new AbortController()
  const abortFromExternal = () => controller.abort(externalSignal.reason ?? new Error(`${label}: activation aborted`))
  if (externalSignal?.aborted) abortFromExternal()
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error(`${label}: activation deadline exceeded`)),
    timeoutMs
  )
  timer.unref?.()
  return {
    controller,
    cleanup() {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', abortFromExternal)
    }
  }
}

export { Config, apply, inject, name }
