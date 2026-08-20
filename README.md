# @yilinxiao/dsh-mcp-lazy 0.5.0

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MCP Token 节省插件。0.5.0 安装后会自动发现并接管通过**兼容性准入**的 DSH MCP：在受管理 MCP 的工具面中，冷启动时模型默认只看到一个共享路由 `mcp__router__search_and_activate`；路由选中服务器后，才向当前会话做 **Schema 按需披露**。下一轮会重新隐藏，避免其他 MCP 的名称、说明和参数结构持续占用模型上下文。普通 DSH 工具不在本插件的过滤范围内。

这是 schema progressive disclosure（模型侧工具 Schema 的渐进披露），不是对第三方 MCP 进程的强制代理。对显式配置到本插件的服务器，仍提供完整的**连接层懒加载**（按需连接、轮末卸载 Schema、可保温复用连接）；其他兼容 DSH MCP 的连接、重试、附件和执行逻辑始终由原插件负责。

## 自动接管的边界

| MCP 类型 | Schema 行为 | 连接行为 | 失败行为 |
| --- | --- | --- | --- |
| 显式 `dsh-mcp-lazy` server | router 选择后仅向当前会话披露 | 按需启动并保温 | 保留原 lazy 错误并恢复隐藏状态 |
| 通过兼容性准入的其他 DSH MCP | router 选择后仅向当前会话披露 | 原插件保持所有权 | fail-open，恢复原工具面 |
| 不兼容或无法确认的 MCP | 完全不接管 | 完全不接管 | 完全保持 DSH 原样 |

兼容性准入要求服务器的全部公开工具稳定匹配 `mcp__<serverName>__<toolName>`，能在 DSH 全局工具表中无歧义解析，并能被按会话原子隐藏和再次披露。**不兼容的 MCP 保持原样**：命名异常、冲突、目录不完整、DSH 能力不足或任一运行时不确定性都不会被强行接管。

这里的原则是 **fail-open**：无法证明“已隐藏的服务器一定可被路由和披露”时，就放弃该服务器的 Token 节省，恢复它原有的工具可见性和执行方式；不会为了省 Token 让工具消失或不可用。

## Token 节省如何理解

工具的名称、说明和参数结构会随模型请求进入上下文。兼容 MCP 越多、工具 Schema 越大，冷启动时只保留一个路由工具的收益通常越明显；路由后披露的目标服务器仍会在随后的模型步骤占用其完整 Schema。这不是整次请求或账单的固定百分比，真实收益应从同类请求的 `prompt_tokens`、缓存命中和未命中数据中比较。

0.4.0 曾在三个真实 MCP 上测得：67 个常驻工具定义约为 9,727 `cl100k_base` Token；旧的显式 lazy 冷态为 6 个控制工具、约 581 Token。0.5.0 的默认冷态改为统一路由和兼容 Schema 接管，不能直接沿用该旧比例；请在自己的 DSH profile 按下面的验证方法测量。

## 安装

```sh
dsh plugin --profile web add @yilinxiao/dsh-mcp-lazy
```

推荐通过 npm 安装；源码与发布记录仍保存在 [GitHub](https://github.com/leaforbook/dsh-mcp-lazy)。

安装包自带的 `cordis.patch.yml` 会启用唯一的 `mcp-lazy-manager`：

```yaml
- insert:
    - id: mcp-lazy-manager
      name: '@yilinxiao/dsh-mcp-lazy'
      config:
        mode: manager
```

它不需要任何 MCP URL、headers 或凭据。安装完成并重启 DSH 后，已安装的兼容 DSH MCP 会自动进入统一路由；不需要把它们逐个复制到本插件配置中。下面的显式 server 配置仅在你希望本插件自己拥有某个 MCP 的连接层懒加载时使用。

### 关闭自动接管

要恢复所有 MCP 的原有 schema 可见性，只禁用 manager 条目即可；显式 lazy server 配置不会受影响：

```sh
dsh plugin --profile web disable mcp-lazy-manager
```

也可以在对应 profile 的 patch 中移除或禁用 id 为 `mcp-lazy-manager` 的条目。无需卸载本 npm 包，也不要修改第三方 MCP 的配置、URL 或凭据。

## 配置

在对应配置目录的 `cordis.patch.yml` 中，可为需要**连接层懒加载**的 MCP 服务器另写一条显式配置：

```yaml
- insert:
    - id: mcp-lazy
      name: '@yilinxiao/dsh-mcp-lazy'
      config:
        transport: stdio
        serverName: filesystem
        command: npx
        args: [-y, '@modelcontextprotocol/server-filesystem', '/tmp']
        connectTimeoutMs: 30000      # 建立连接超时，默认 30 秒
        discoveryTimeoutMs: 60000    # 每页 tools/list 超时，默认 60 秒
        maxToolListPages: 100        # 最多读取的工具目录页数，默认 100
        reconnectAttempts: 1         # 意外断开后的有限重连次数，默认 1
        autoActivate: false          # 是否在启动时直接连接，默认 false
        releaseOnTurnEnd: true       # 是否在轮次结束后卸载远端工具 Schema，默认 true
        warmIdleMs: 300000           # Schema 卸载后连接保温时长，默认 5 分钟
        routingHints: [文件, 目录]    # 供共享路由器匹配的提示词，默认 []

    - id: mcp-lazy
      name: '@yilinxiao/dsh-mcp-lazy'
      config:
        transport: streamable-http
        serverName: remote-api
        url: http://127.0.0.1:8000/mcp
        headers: {}
        warmIdleMs: 300000
        routingHints: [远程接口, API]
```

### 配置项

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `transport` | `stdio` \| `streamable-http` | — | 必填。MCP 传输方式。 |
| `serverName` | string | — | 必填。允许 `[A-Za-z0-9_-]{1,32}`，同时用作工具名前缀。 |
| `command` / `args` / `env` / `cwd` | — | — | `stdio` 启动参数。`env` 会合并到脱敏后的父进程环境。 |
| `url` / `headers` | — | — | `streamable-http` 的服务地址和请求头。 |
| `toolCallTimeoutMs` | number | `60000` | 单次工具调用超时，单位为毫秒。 |
| `connectTimeoutMs` | number | `30000` | 建立 MCP 连接的超时，单位为毫秒。 |
| `discoveryTimeoutMs` | number | `60000` | 单页 `tools/list` 请求的超时，单位为毫秒；激活流程另有略短于 180 秒控制工具超时的总 deadline。 |
| `maxToolListPages` | number | `100` | 一次目录发现最多读取的页数；重复游标、重名工具或超限都会中止。 |
| `reconnectAttempts` | number | `1` | 意外断开且仍有当前轮使用者、跨轮次持有者或自动激活所有权时的重连次数。设为 `0` 可关闭；成功调用工具后恢复预算。 |
| `autoActivate` | boolean | `false` | 启动时直接连接服务器。开启后不再按需加载。 |
| `releaseOnTurnEnd` | boolean | `true` | 本轮结束且没有会话继续使用时，立即卸载远端工具 Schema。设为 `false` 时，实际激活或调用过服务器的会话会跨轮次持有发布；无关会话的销毁不会释放它，最后一个真实持有会话销毁后才卸载。 |
| `warmIdleMs` | number | `300000` | Schema 卸载后的连接保温时长，单位为毫秒。仅接受非负整数，无效值回退为 5 分钟；设为 `0` 可恢复 0.3.x 的轮末立即关闭连接行为。 |
| `routingHints` | string[] | `[]` | 共享路由器用于匹配服务器的关键词，例如业务名称、能力或自然语言别名。 |

## 工作原理

1. manager 监听 DSH 的全局工具目录。通过兼容性准入的 `mcp__<server>__<tool>` 命名空间会被完整、原子地加入目录；普通工具、共享 router 名称、冲突名称和无法稳定解析的 MCP 都是 passthrough。
2. 每个 agent 有独立 deny mask。冷态屏蔽所有已准入 MCP 的 schema，仅保留 `mcp__router__search_and_activate`；路由器选择一个服务器后，只从该 agent 的 deny mask 中移除该服务器。其他 agent 和其他 MCP 始终保持隐藏。
3. `agent/turn-stopping` 会清除本轮选择并恢复完整 deny mask，`agent/disposed` 会清理该 agent 的 restriction。注册表变更、restriction 失败或目录验证失败时立即 fail-open，而不是留下半隐藏状态。
4. 对显式 `dsh-mcp-lazy` server，路由器会按既有规则参考精确 `serverName`、完整工具前缀、`routingHints` 和缓存目录；匹配成功时再以 `stdio` 或 `streamable-http` 建连、发现并发布原生工具。`releaseOnTurnEnd: true` 时轮末卸载 Schema，`warmIdleMs` 内重用连接；`releaseOnTurnEnd: false` 和 `autoActivate` 保留现有持有语义。
5. 对被动接管的第三方 DSH MCP，router 只披露已由原插件注册的同一份 ToolDefinition，绝不包装或替换执行器。因此 structured content、图片/附件、权限、审计、重试、重连与进程生命周期仍归原插件所有。

## 验证自动接管

1. 安装后重启 DSH，创建一个新的会话；在受管理 MCP 子集的冷态工具目录中应只呈现 `mcp__router__search_and_activate`，而已通过兼容性准入的 MCP 不会在模型请求中常驻。普通 DSH 工具保持可见。
2. 让模型调用 router 并选择一个兼容服务器；下一步只会披露该服务器的工具，调用仍由原 MCP 执行。
3. 结束该轮或新开会话，已披露工具应再次隐藏；另一会话不应继承前一会话的披露。
4. 如发现某个 MCP 始终可见，先检查其公开名称、重复名称和 DSH 日志。这通常表示它未通过兼容性准入，属于预期的 passthrough，而不是功能失效。

## 兼容性

Universal manager 通过能力检测而不是版本字符串强制启用；缺少 `tools.schemas`、`tools.get` 或 agent scoped `tools.restrict` 时不会安装任何全局限制。CI 已对 DSH `0.1.0-rc.6、0.1.0-rc.7 和 0.1.0-rc.8` 执行插件导入、manager 生命周期和显式 lazy server 共存验证。升级 DSH 大版本后，建议先运行本仓库的兼容测试再在生产 profile 启用。

## 限制

- 自动接管只优化模型侧 schema；它不会也不应停止、重启或代理不透明第三方 MCP 进程。需要按需启动连接时，请使用上面的显式 `dsh-mcp-lazy` server 配置。
- 一个 MCP 只有在完整命名空间都可无歧义路由、隐藏和再次披露时才会被接管。不能证明安全性的服务器会保持可见，这是 fail-open 的设计结果。
- 不支持必须以任务方式执行的工具，即 `tool.execution.taskSupport === 'required'`。遇到这类工具会直接返回错误。
- 自动重连是有界的，且只在仍有连接需求时发生。超过预算后需重新调用 `activate`；成功调用任一服务器工具会恢复重连预算。
- 保温只复用当前进程内的连接和工具目录，不写磁盘；进程重启后仍需重新发现。
- TOKEN 数据是工具定义的近似值，不代表请求的全部输入，也不能直接换算成账单金额。

## 测试

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm test
```

测试覆盖兼容性准入、agent 隔离、动态目录、restriction fail-open、被动 MCP 原执行器保留、显式 lazy 生命周期，以及真实 stdio MCP 客户端/服务端的分页、调用和目录变更通知。CI 还覆盖 DSH rc.6、rc.7、rc.8 的宿主依赖图。

## 许可证

MIT
