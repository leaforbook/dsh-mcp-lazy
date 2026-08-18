import { createRefreshCoordinator, reconcileRegistrations } from './lazy-core.js'

const ACTIVATE_INTERNAL_TIMEOUT_MS = 175000
const RECONNECT_DELAY_MS = 100

function createServerRuntime({
  adapter,
  config,
  label,
  reconnectAttempts,
  createConnectedClient,
  discoverDefinitions
}) {
  let client
  let connectingClient
  let catalog = new Map()
  let registrations = new Map()
  let activation = null
  let activationController
  let reconnectTimer
  let reconnectPending = false
  let warmTimer
  let users = new Set()
  let reconnectRemaining = reconnectAttempts
  let disposed = false
  const clientClosures = new WeakMap()

  function addUser(agent) {
    if (agent) users.add(agent)
  }

  function markSuccessfulUse(agent) {
    addUser(agent)
    reconnectRemaining = reconnectAttempts
  }

  function getCatalog() {
    return [...catalog.values()].map((entry) => ({ ...entry.summary }))
  }

  function wantsConnection() {
    return users.size > 0 || config.autoActivate
  }

  function shouldPublishCatalog() {
    return users.size > 0 || config.autoActivate || config.releaseOnTurnEnd === false
  }

  function unpublishTools() {
    const count = registrations.size
    for (const entry of registrations.values()) {
      try { entry.dispose() } catch (error) { adapter.log('warn', `${label}: tool disposal failed: ${String(error)}`) }
    }
    registrations = new Map()
    return count
  }

  function publishCatalog(nextCatalog = catalog) {
    registrations = reconcileRegistrations(
      registrations,
      nextCatalog,
      (definition) => adapter.registerTool(definition)
    )
  }

  function clearWarmTimer() {
    if (warmTimer === undefined) return
    clearTimeout(warmTimer)
    warmTimer = undefined
  }

  function cancelReconnect() {
    reconnectPending = false
    if (reconnectTimer === undefined) return
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  function closeClient(target) {
    if (target === undefined) return Promise.resolve()
    const existing = clientClosures.get(target)
    if (existing !== undefined) return existing
    const closing = Promise.resolve()
      .then(() => target.close())
      .catch((error) => adapter.log('warn', `${label}: close failed: ${String(error)}`))
    clientClosures.set(target, closing)
    return closing
  }

  async function hardClose(abortReason = new Error(`${label}: connection closed`)) {
    clearWarmTimer()
    cancelReconnect()
    activationController?.abort(abortReason)

    const pendingActivation = activation
    const activeClient = client
    const pendingClient = connectingClient
    client = undefined
    connectingClient = undefined
    const count = unpublishTools()
    users.clear()
    reconnectRemaining = 0

    await Promise.all([...new Set([activeClient, pendingClient])].map(closeClient))
    if (pendingActivation) {
      try { await pendingActivation } catch {}
    }
    cancelReconnect()
    return count
  }

  function beginWarmIdle(reason) {
    if (warmTimer !== undefined) return
    const count = unpublishTools()
    adapter.log('info', `${label}: ${reason}，${count} 个工具已卸载，连接保温 ${config.warmIdleMs}ms`)
    if (config.warmIdleMs === 0) return hardClose()
    clearWarmTimer()
    warmTimer = setTimeout(() => {
      warmTimer = undefined
      void hardClose().catch((error) => adapter.log('error', `${label}: 保温连接关闭失败: ${String(error)}`))
    }, config.warmIdleMs)
    warmTimer.unref?.()
  }

  function scheduleReconnect() {
    if (disposed || client || reconnectTimer !== undefined || !wantsConnection() || reconnectRemaining <= 0) return
    if (activation) {
      reconnectPending = true
      return
    }
    reconnectPending = false
    const attempt = reconnectAttempts - reconnectRemaining + 1
    adapter.log('warn', `${label}: 连接意外断开，准备有限自动重连（${attempt}/${reconnectAttempts}）`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (disposed || client || activation || !wantsConnection()) return
      reconnectRemaining -= 1
      void activate(undefined, true).then((message) => {
        if (client) adapter.log('info', `${label}: 自动重连成功`)
        else {
          adapter.log('warn', `${label}: 自动重连未成功: ${message}`)
          scheduleReconnect()
        }
      }).catch((error) => {
        adapter.log('error', `${label}: 自动重连失败: ${String(error)}`)
        scheduleReconnect()
      })
    }, RECONNECT_DELAY_MS)
    reconnectTimer.unref?.()
  }

  function onUnexpectedClose(closedClient) {
    if (client !== closedClient && connectingClient !== closedClient) return
    if (client === closedClient) client = undefined
    if (connectingClient === closedClient) connectingClient = undefined
    clearWarmTimer()
    const count = unpublishTools()
    adapter.log('warn', `${label}: 连接已断开，${count} 个工具已卸载`)
    scheduleReconnect()
  }

  async function refreshCatalog(targetClient) {
    if (client !== targetClient || disposed) return
    const before = catalog.size
    const definitions = await discoverDefinitions(targetClient)
    if (client !== targetClient || disposed) return
    if (shouldPublishCatalog()) publishCatalog(definitions)
    catalog = definitions
    adapter.log('info', `${label}: tool list refreshed (${before} -> ${catalog.size})`)
  }

  async function activate(agent, automatic = false, externalSignal) {
    addUser(agent)
    clearWarmTimer()
    if (!automatic) reconnectRemaining = reconnectAttempts
    if (activation) return activation

    if (client && registrations.size === 0) {
      try {
        publishCatalog()
        return `已从保温连接重新激活 MCP 服务器 "${config.serverName}"（${registrations.size} 个工具）。`
      } catch (error) {
        adapter.log('error', `${label}: 保温目录重新发布失败: ${String(error)}`)
        return `激活 "${config.serverName}" 失败：${String(error)}`
      }
    }
    if (client) return `MCP 服务器 "${config.serverName}" 已处于激活状态（${registrations.size} 个工具在线），无需重复激活。`
    if (automatic && !wantsConnection()) return `未重连 "${config.serverName}"：当前已无活跃使用者。`

    activation = (async () => {
      const activationAbort = createActivationAbort(externalSignal, ACTIVATE_INTERNAL_TIMEOUT_MS, label)
      activationController = activationAbort.controller
      let connectedClient
      let closedDuringConnect = false
      const refresh = createRefreshCoordinator(async () => {
        if (connectedClient === undefined) return
        await refreshCatalog(connectedClient)
      })
      try {
        const gen = await createConnectedClient(activationAbort.controller.signal, {
          onClose(closedClient) {
            if (connectedClient === undefined) {
              connectedClient = closedClient
              connectingClient = closedClient
              closedDuringConnect = true
            }
            onUnexpectedClose(closedClient)
          },
          onToolsChanged(changedClient) {
            if (changedClient !== connectedClient) return
            return refresh.request().catch((error) => {
              adapter.log('error', `${label}: tool refresh failed; keeping last good catalog: ${String(error)}`)
            })
          }
        })
        connectedClient = gen
        if (closedDuringConnect) throw new Error(`${label}: connection closed during activation`)
        connectingClient = gen
        if (disposed) throw new Error(`${label}: plugin disposed during activation`)
        if (activationAbort.controller.signal.aborted) throw activationAbort.controller.signal.reason
        if (!wantsConnection()) throw new Error(`${label}: activation no longer needed`)

        client = gen
        connectingClient = undefined
        const definitions = await discoverDefinitions(gen, activationAbort.controller.signal)
        if (client !== gen) throw new Error(`${label}: connection closed during activation`)
        if (disposed) throw new Error(`${label}: plugin disposed during activation`)
        if (activationAbort.controller.signal.aborted) throw activationAbort.controller.signal.reason
        if (!wantsConnection()) throw new Error(`${label}: activation no longer needed`)

        publishCatalog(definitions)
        catalog = definitions
        adapter.log('info', `${label}: 已激活，注册 ${registrations.size} 个工具`)
        const releaseNote = config.releaseOnTurnEnd ? '，本轮结束后自动卸载' : ''
        return `已激活 MCP 服务器 "${config.serverName}"（${registrations.size} 个工具${releaseNote}）。`
      } catch (error) {
        const gen = connectedClient
        if (client === gen) client = undefined
        if (connectingClient === gen) connectingClient = undefined
        clearWarmTimer()
        unpublishTools()
        void closeClient(gen)
        adapter.log('error', `${label}: 激活失败: ${String(error)}`)
        return `激活 "${config.serverName}" 失败：${String(error)}`
      } finally {
        activationAbort.cleanup()
        if (activationController === activationAbort.controller) activationController = undefined
        if (connectingClient === connectedClient) connectingClient = undefined
        activation = null
        if (reconnectPending) scheduleReconnect()
      }
    })()
    return activation
  }

  async function deactivate(reason) {
    const wasActive = client !== undefined
    const count = await hardClose(new Error(`${label}: deactivated`))
    if (!wasActive) return `MCP 服务器 "${config.serverName}" 当前未激活，无需停用。`
    if (reason) {
      adapter.log('info', `${label}: ${reason}，${count} 个工具已自动卸载`)
      return `已停用 MCP 服务器 "${config.serverName}"（${reason}），其 ${count} 个工具已从工具目录中卸载。`
    }
    adapter.log('info', `${label}: 已停用，${count} 个工具已卸载`)
    return `已停用 MCP 服务器 "${config.serverName}"，其 ${count} 个工具已从工具目录中卸载。`
  }

  function releaseWhenUnused(reason) {
    if (users.size !== 0 || config.autoActivate) return
    cancelReconnect()
    activationController?.abort(new Error(`${label}: no active users remain`))
    if (client !== undefined) {
      const closing = beginWarmIdle(reason)
      void closing?.catch((error) => adapter.log('error', `${label}: 自动释放失败: ${String(error)}`))
    } else {
      unpublishTools()
    }
  }

  function onTurnStopping(payload) {
    const before = users.size
    users.delete(payload?.agent)
    if (!config.releaseOnTurnEnd) return
    if (users.size !== before) releaseWhenUnused('本轮对话结束，无会话继续使用')
  }

  function onAgentDisposed(payload) {
    users.delete(payload?.agent)
    releaseWhenUnused('会话已销毁')
  }

  function dispose() {
    if (disposed) return
    disposed = true
    return hardClose(new Error(`${label}: plugin disposed`))
  }

  return {
    activate,
    deactivate,
    getCatalog,
    onTurnStopping,
    onAgentDisposed,
    dispose,
    addUser,
    markSuccessfulUse
  }
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

export { createServerRuntime }
