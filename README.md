# @yilinxiao/dsh-mcp-lazy

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的按需 MCP 桥接插件。它不会在启动时把 MCP 服务器的全部工具塞进工具目录，而是为每个服务器保留 `activate` 和 `deactivate` 两个控制工具，并在同一工具域共享一个 `mcp__router__search_and_activate` 路由工具。需要哪个服务器时，可让路由器搜索并激活，也可明确调用服务器自己的 `activate`；本轮结束后立即卸载远端工具 Schema，默认将连接保温 5 分钟以便下一轮复用。

这样做主要是为了少占 TOKEN。工具的名称、说明和参数结构会随模型请求一起进入上下文。MCP 服务器越多、工具定义越长，常驻目录消耗的输入 TOKEN 就越多。这个插件让没用到的工具不进入当轮请求。

## 工具定义本身能少多少 TOKEN

下面的数据来自三个真实 MCP 服务器，测试时间为 2026-08-18。“全量常驻”按 `@deepseek-ai/dsh-mcp-client` 的方式统计，“按需模式”按每个服务器未激活时的两个专用控制工具统计。0.4.0 新增的共享路由工具是整个 DSH 工具域一份固定开销，未计入各服务器行。TOKEN 使用 `cl100k_base` 统一计算，适合比较工具定义的前后差额。

| MCP 服务器 | 全量常驻 | 按需模式未激活 | 全量工具定义 | 按需工具定义 | 每轮减少 | 工具定义降幅 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chrome DevTools MCP 1.7.0 | 29 个工具 | 2 个工具 | 4,585 TOKEN | 200 TOKEN | 4,385 TOKEN | 95.6% |
| Playwright MCP 0.0.79 | 24 个工具 | 2 个工具 | 3,452 TOKEN | 195 TOKEN | 3,257 TOKEN | 94.4% |
| Filesystem MCP 2026.7.10 | 14 个工具 | 2 个工具 | 1,694 TOKEN | 190 TOKEN | 1,504 TOKEN | 88.8% |
| 三个服务器合计 | 67 个工具 | 6 个工具 | 9,727 TOKEN | 581 TOKEN | 9,146 TOKEN | 94.0% |

表里的 `94.0%` 只表示工具定义缩小了多少，不能当成整次请求的 TOKEN 降幅。整次请求还包括系统提示、聊天记录、用户消息和其他工具。上下文越长，这 9,146 TOKEN 在总输入里的占比就越小。

## 整次请求大约能省多少

仍以三个服务器的合计数据为例，设 `C` 为工具定义之外的输入 TOKEN：

- 全量常驻：约 `C + 9,727`
- 按需未激活：约 `C + 581`
- 输入降幅：约 `9,146 ÷ (C + 9,727)`

| 其他上下文 `C` | 全量常驻总输入 | 按需未激活总输入 | 约减少 | 整次输入降幅 |
| ---: | ---: | ---: | ---: | ---: |
| 0 TOKEN | 9,727 TOKEN | 581 TOKEN | 9,146 TOKEN | 94.0% |
| 10,000 TOKEN | 19,727 TOKEN | 10,581 TOKEN | 9,146 TOKEN | 46.4% |
| 50,000 TOKEN | 59,727 TOKEN | 50,581 TOKEN | 9,146 TOKEN | 15.3% |
| 100,000 TOKEN | 109,727 TOKEN | 100,581 TOKEN | 9,146 TOKEN | 8.3% |

这里的绝对值仍是 `cl100k_base` 估算，不等同于 DeepSeek API 的精确 TOKEN。DeepSeek 还会把输入分成缓存命中和未命中两部分，两者的实际费用可能不同。要核算真实收益，应比较同类请求返回的 [`prompt_tokens`、`prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)，不能直接用单轮估算乘以轮数。

## 什么时候省，什么时候不省

- 服务器未激活时，每个服务器只保留两个专用控制工具，整个工具域另共享一个搜索激活路由器，仍是最省 TOKEN 的状态。
- 激活服务器后，它的全部工具会在当前轮注册；这一轮仍要承担该服务器的工具定义 TOKEN。
- 默认会在轮次结束时立即卸载远端工具 Schema；专用控制工具和共享路由器仍然可用。
- 默认连接继续保温 5 分钟。保温期内再次激活会直接复用内存目录和现有连接，不重新启动 MCP 进程。
- `releaseOnTurnEnd: false` 会让实际激活或调用过该服务器的会话成为跨轮次持有者；直到最后一个持有会话销毁前，Schema 和连接都会保持可用。
- 如果服务器本来只有一两个很短的工具，按需模式的 TOKEN 优势可能很小。
- `autoActivate: true` 会在启动时直接连接服务器，相当于关闭懒加载，不再节省这部分 TOKEN。

## 安装

```sh
dsh plugin --profile web add @yilinxiao/dsh-mcp-lazy
```

推荐通过 npm 安装；源码与发布记录仍保存在 [GitHub](https://github.com/leaforbook/dsh-mcp-lazy)。

安装时会加入一个默认停用的 `mcp-lazy` 配置占位，不会在缺少服务器参数时启动插件。完成下面的服务器配置后才会实际连接 MCP。

## 配置

在对应配置目录的 `cordis.patch.yml` 中，每个 MCP 服务器写一条配置：

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

1. 同一 DSH 工具域只注册一个 `mcp__router__search_and_activate`，每个服务器仍保留 `mcp__<server>__activate` 和 `mcp__<server>__deactivate`。路由器依次参考精确 `serverName`、完整工具前缀、`routingHints` 和已缓存目录；完整前缀先保留大小写做精确匹配，只有大小写折叠后的候选唯一时才回退匹配，因此 `Foo` / `foo` 之类的歧义不会被猜中。零匹配或最高分并列时同样不会激活任何服务器。
   共享路由器的宿主注册归属于当前某个插件上下文；该 Cordis fiber 卸载而其他服务器仍存活时，注册会转移到一个存活上下文，仍保持每个工具域恰好一份。
   如果已有配置使用 `serverName: router`，且该 MCP 原生提供 `search_and_activate`，两个工具会得到同一个公开名称。宿主注册表无法同时暴露同名工具，因此激活期间由原生工具占用该名称；原生工具卸载后自动恢复共享路由器，其他服务器自己的 `activate` / `deactivate` 始终可用。
2. 路由器选中服务器或明确调用 `activate` 后，插件通过 `stdio` 或 `streamable-http` 连接服务器，带超时和页数上限分页读取 `tools/list`，再注册服务器提供的全部工具。激活结果只返回工具数量，不重复输出完整名称列表。
3. 工具名沿用 `dsh-mcp-client` 的规则：`mcp__<server>__<tool>`。名称只保留 `[A-Za-z0-9_-]`，最长 64 个字符；出现冲突时追加 12 位哈希。
4. `releaseOnTurnEnd: true` 时，默认在 `agent/turn-stopping` 立即卸载远端工具 Schema，并把连接保温 `warmIdleMs`；保温期再次激活会直接从内存目录恢复 Schema。设为 `false` 时，当前轮使用者与跨轮次持有者分别记录：轮次停止只清除当前轮需求，持有权一直保留到对应的 `agent/disposed`；多个持有者必须全部销毁才会释放，无关会话的销毁不产生影响。`autoActivate` 是独立的常驻所有权；显式 `deactivate` 和插件销毁始终立即关闭连接。
5. 收到 `tools/list/changed` 后，插件先完整拉取并验证新目录，再按指纹差量更新：未变化的工具不重复注册，刷新失败则保留最后一次可用目录。每次发现都有单调递增的代次，较早的激活发现即使更晚返回也不能覆盖更新的刷新结果。保温且没有活跃使用者时只更新内存目录，不重新发布 Schema；并发通知会合并，刷新期间的新通知会在本次完成后再同步一次。
6. 连接意外断开时会立即卸载失效工具。仍有当前轮使用者、跨轮次持有者（或启用了 `autoActivate`）时，插件按 `reconnectAttempts` 做有限自动重连，不会无限后台循环。

## 限制

- 不支持必须以任务方式执行的工具，即 `tool.execution.taskSupport === 'required'`。遇到这类工具会直接返回错误。
- 自动重连是有界的，且只在仍有连接需求时发生。超过预算后需重新调用 `activate`；成功调用任一服务器工具会恢复重连预算。
- 保温只复用当前进程内的连接和工具目录，不写磁盘；进程重启后仍需重新发现。
- TOKEN 数据是工具定义的近似值，不代表请求的全部输入，也不能直接换算成账单金额。

## 测试

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm test
```

测试覆盖分页与游标保护、稳定指纹、差量更新、注册失败回滚、刷新通知合并，以及真实 stdio MCP 客户端/服务端的分页、调用和目录变更通知。

## 许可证

MIT
