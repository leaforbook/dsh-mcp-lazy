# DSH MCP Lazy（@yilinxiao/dsh-mcp-lazy）

这是一个给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 使用的插件。

一句话说明它的用途：**MCP 装得越多，模型每轮都要读取的工具说明就越多；这个插件会先把暂时用不到的工具说明藏起来，需要时再加载，从而减少 Token 消耗。**

当前版本：`0.5.1`

## 它解决了什么问题

假设你在 DSH 里装了文件、浏览器、数据库等多个 MCP。即使当前问题只需要文件工具，所有 MCP 的工具名称、说明和参数也可能一起进入模型上下文，白白占用 Token。

安装本插件后：

1. 新会话开始时，兼容 MCP 的大量工具不会全部出现。在这些被接管的 MCP 工具中，模型只会看到一个路由工具：`mcp__router__search_and_activate`。
2. 当任务需要某个 MCP 时，路由工具会找到它，并只向当前会话显示这个 MCP 的工具。
3. 当前轮结束后，这些工具会再次隐藏，下一轮不用重复携带。
4. 其他会话不会继承本会话已经加载的工具。

这个过程叫做 **Schema 按需披露**。这里的 Schema 可以简单理解为“模型调用工具前必须阅读的工具说明书”。

普通 DSH 工具不会被隐藏。不符合要求、无法安全接管的 MCP 也会保持原样，因此不会为了节省 Token 影响工具使用。

## 安装

```sh
dsh plugin --profile web add @yilinxiao/dsh-mcp-lazy
```

安装后重启 DSH 即可。插件会自动发现已经安装的兼容 MCP，不需要逐个填写 MCP 地址、请求头或密钥。

源码和版本记录在 [GitHub](https://github.com/leaforbook/dsh-mcp-lazy)。

## 装完以后怎么用

正常向模型提问即可，不需要手动操作插件。

例如你可以说：

> 帮我找出项目里所有超过 10 MB 的 PDF 文件。

模型会先通过共享路由找到文件 MCP，再调用它的原生工具。插件只负责决定“什么时候让模型看到哪些工具”，真正的工具调用仍由原 MCP 完成。

安装包会自动加入下面这条 manager 配置：

```yaml
- insert:
    - id: mcp-lazy-manager
      name: '@yilinxiao/dsh-mcp-lazy'
      config:
        mode: manager
```

通常不需要手动修改它。

## 能节省多少 Token

节省量取决于你装了多少 MCP，以及它们的工具说明有多长。MCP 越多、工具越复杂，效果通常越明显。

0.4.0 的显式懒加载模式曾对三个常见 MCP 的工具说明做过统一测量：

| MCP | 原来常驻的工具 | 使用插件后的冷态工具 | 工具说明 Token 减少 |
| --- | ---: | ---: | ---: |
| Chrome DevTools MCP 1.7.0 | 29 个 | 2 个控制工具 | 4,585 → 200，减少 95.6% |
| Playwright MCP 0.0.79 | 24 个 | 2 个控制工具 | 3,452 → 195，减少 94.4% |
| Filesystem MCP 2026.7.10 | 14 个 | 2 个控制工具 | 1,694 → 190，减少 88.8% |
| 合计 | 67 个 | 6 个控制工具 | 9,727 → 581，减少 94.0% |

0.5.0 的自动接管测试中，冷态工具说明从 404 Token 降到 63 Token，减少了 84.4%。测试里的工具说明较短，大型 MCP 通常能省下更多绝对 Token。

这里的百分比只表示“工具说明”缩小了多少，不代表整次请求或账单一定下降同样的比例。聊天记录、系统提示和用户输入仍会占用 Token。

<details>
<summary>查看完整的 Token 计算示例</summary>

以上面三个 MCP 为例，工具说明每轮少了约 9,146 Token。如果请求中还有其他上下文，整次输入大约会变成：

| 其他上下文 | 原总输入 | 使用插件后 | 约减少 | 整次输入降幅 |
| ---: | ---: | ---: | ---: | ---: |
| 0 Token | 9,727 | 581 | 9,146 | 94.0% |
| 10,000 Token | 19,727 | 10,581 | 9,146 | 46.4% |
| 50,000 Token | 59,727 | 50,581 | 9,146 | 15.3% |
| 100,000 Token | 109,727 | 100,581 | 9,146 | 8.3% |

这些数据使用 `cl100k_base` 对相同格式的工具说明进行比较，只适合观察前后差异，不等同于 DeepSeek 的精确计费 Token。要核算实际收益，请比较同类请求的 `prompt_tokens` 和缓存命中数据。

</details>

## 哪些 MCP 会被自动接管

插件会先做一次**兼容性准入**检查。只有工具名称清楚、没有冲突，而且能够安全隐藏和重新显示的 MCP，才会被接管。

| MCP 类型 | 插件会怎么处理 | MCP 连接由谁管理 |
| --- | --- | --- |
| 显式 `dsh-mcp-lazy` server | 需要时显示工具，并按需建立连接 | 本插件 |
| 通过兼容性准入的其他 DSH MCP | 需要时显示原 MCP 已注册的工具 | 原 MCP 插件 |
| 不兼容或无法确认的 MCP | 完全不接管，工具照常可见 | 原 MCP 插件 |

**不兼容的 MCP 保持原样。** 出现命名异常、工具重名、目录不完整或 DSH 能力不足等情况时，插件会主动放弃接管。

技术上，这种处理方式叫 **fail-open**：只要无法确定接管是安全的，就优先保证工具可用，不强求节省 Token。

## 关闭自动接管

如果你想让所有 MCP 恢复原来的显示方式，只禁用 manager 条目即可。在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中加入：

```yaml
- id: mcp-lazy-manager
  disabled: true
```

请保留这段覆盖配置；删掉后，安装包会再次启用 manager。

它只关闭自动接管，显式 lazy server 配置不会受影响。你不需要卸载 npm 包，也不用修改其他 MCP 的地址、请求头或密钥。

## 需要连 MCP 时才启动它

自动接管主要减少模型看到的工具说明，不会关闭第三方 MCP 进程。

如果你还希望某个 MCP 平时不连接、用到时才启动，可以把它显式配置为本插件的 server。这称为**连接层懒加载**。

<details>
<summary>查看 stdio 和 HTTP 配置示例</summary>

在对应配置目录的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: mcp-lazy
      name: '@yilinxiao/dsh-mcp-lazy'
      config:
        transport: stdio
        serverName: filesystem
        command: npx
        args: [-y, '@modelcontextprotocol/server-filesystem', '/tmp']
        connectTimeoutMs: 30000
        discoveryTimeoutMs: 60000
        maxToolListPages: 100
        reconnectAttempts: 1
        autoActivate: false
        releaseOnTurnEnd: true
        warmIdleMs: 300000
        routingHints: [文件, 目录]

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

</details>

### 显式 server 配置说明

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `transport` | 无 | 必填。使用 `stdio` 或 `streamable-http`。 |
| `serverName` | 无 | 必填。服务器简称，只能使用字母、数字、下划线和短横线，最长 32 个字符。 |
| `command` / `args` / `env` / `cwd` | 无 | `stdio` 模式下的启动命令、参数、环境变量和工作目录。 |
| `url` / `headers` | 无 | HTTP 模式下的服务地址和请求头。 |
| `toolCallTimeoutMs` | `60000` | 一次工具调用最多等待多少毫秒。 |
| `connectTimeoutMs` | `30000` | 建立连接最多等待多少毫秒。 |
| `discoveryTimeoutMs` | `60000` | 读取一页工具目录最多等待多少毫秒。 |
| `maxToolListPages` | `100` | 一次最多读取多少页工具目录。 |
| `reconnectAttempts` | `1` | 意外断开后最多自动重连几次，设为 `0` 可关闭。 |
| `autoActivate` | `false` | 是否在 DSH 启动时立即连接。开启后不再按需连接。 |
| `releaseOnTurnEnd` | `true` | 当前轮结束后是否隐藏已经加载的工具说明。 |
| `warmIdleMs` | `300000` | 工具隐藏后继续保留连接多久，默认 5 分钟；设为 `0` 会立即断开。 |
| `routingHints` | `[]` | 帮助路由器识别这个 MCP 的关键词，如业务名、能力或常用叫法。 |

连接保温的作用是：本轮结束后先隐藏工具说明，但暂时不断开 MCP。短时间内再次使用时，可以直接复用连接，减少等待。

## 怎么确认插件已经生效

1. 安装并重启 DSH。
2. 新建一个会话。
3. 在冷态工具列表中，已经被接管的 MCP 工具应该隐藏，只留下共享路由 `mcp__router__search_and_activate`；普通 DSH 工具仍然可见。
4. 提出一个需要某个 MCP 的任务。路由完成后，模型应该只看到这个 MCP 的工具，并能正常调用。
5. 新建另一个会话。前一个会话加载过的 MCP 工具不应出现在新会话中。

如果某个 MCP 一直可见，通常说明它没有通过兼容性检查，因此被保留为原来的工作方式。这不代表插件失效。

## 兼容性

已经测试的 DSH 版本：`0.1.0-rc.6、0.1.0-rc.7 和 0.1.0-rc.8`。

插件实际通过 DSH 是否提供所需能力来决定能否启用，而不是只看版本号。如果缺少工具目录读取、工具查询或按会话隐藏工具等能力，插件不会施加全局限制。

DSH 升级大版本后，建议先运行本仓库的兼容测试，再用于重要环境。

## 使用限制

- 自动接管只减少模型侧的工具说明，不负责停止、重启或代理第三方 MCP 进程。
- 只有能够被准确识别、安全隐藏并重新显示的完整 MCP，才会被接管。
- 不支持 `tool.execution.taskSupport === 'required'` 的任务型工具，调用时会直接返回错误。
- 自动重连次数有限。超过次数后，需要重新调用 `activate`。
- 保温连接只存在于当前 DSH 进程中，不会写入磁盘。DSH 重启后需要重新读取工具目录。
- Token 数据是工具说明的近似测量，不能直接换算为账单金额。

## 给开发者的工作原理

1. manager 监听 DSH 的工具目录，只接管能够完整识别的 `mcp__<server>__<tool>` 工具组。普通工具、重名工具和无法确认来源的 MCP 直接放行。
2. 每个会话都有独立的隐藏列表。路由器选中一个 MCP 后，只在当前会话中显示它的工具。
3. 当前轮结束或会话关闭时，插件会恢复隐藏状态并清理会话数据。
4. 目录发生变化或隐藏操作失败时，插件会执行 fail-open，恢复原工具的可见性。
5. 对第三方 MCP，插件只显示原 MCP 注册的工具定义，不替换执行器。因此图片、附件、权限、审计、重试和进程生命周期仍由原插件负责。
6. 对显式配置的 server，插件还负责连接层懒加载、工具目录分页、有限重连和连接保温，支持 `stdio` 与 `streamable-http`。

## 测试

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm test
```

测试覆盖自动接管、会话隔离、动态工具目录、安全放行、原 MCP 执行器保留、显式 server 生命周期，以及真实 stdio MCP 的分页、调用和目录变化通知。CI 还会测试 DSH rc.6、rc.7 和 rc.8。

## 许可证

MIT
