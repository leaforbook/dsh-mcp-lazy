# @xiaoyilin/dsh-mcp-lazy

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的按需 MCP 桥接插件。它不会在启动时把 MCP 服务器的全部工具塞进工具目录，而是先为每个服务器注册 `activate` 和 `deactivate` 两个控制工具。需要用哪个服务器，再临时连接并加载它的工具；本轮结束后自动卸载。

这样做主要是为了少占 TOKEN。工具的名称、说明和参数结构会随模型请求一起进入上下文。MCP 服务器越多、工具定义越长，常驻目录消耗的输入 TOKEN 就越多。这个插件让没用到的工具不进入当轮请求。

## 工具定义本身能少多少 TOKEN

下面的数据来自三个真实 MCP 服务器，测试时间为 2026-08-18。“全量常驻”按 `@deepseek-ai/dsh-mcp-client` 的方式统计，“按需模式”使用本插件未激活时的两个控制工具。TOKEN 使用 `cl100k_base` 统一计算，适合比较工具定义的前后差额。

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

- 服务器未激活时，目录里只有两个控制工具，省得最多。
- 激活服务器后，它的全部工具会在当前轮注册；这一轮仍要承担该服务器的工具定义 TOKEN。
- 默认会在轮次结束时卸载工具，下一轮恢复到两个控制工具。
- 如果服务器本来只有一两个很短的工具，按需模式的 TOKEN 优势可能很小。
- `autoActivate: true` 会在启动时直接连接服务器，相当于关闭懒加载，不再节省这部分 TOKEN。

## 安装

```sh
dsh plugin --profile web add github:leaforbook/dsh-mcp-lazy
```

本项目直接通过 GitHub 分发，不发布到 npm。

## 配置

在对应配置目录的 `cordis.patch.yml` 中，每个 MCP 服务器写一条配置：

```yaml
- insert:
    - id: mcp-lazy
      name: '@xiaoyilin/dsh-mcp-lazy'
      config:
        transport: stdio
        serverName: filesystem
        command: npx
        args: [-y, '@modelcontextprotocol/server-filesystem', '/tmp']
        autoActivate: false          # 是否在启动时直接连接，默认 false
        releaseOnTurnEnd: true       # 是否在轮次结束后断开，默认 true

    - id: mcp-lazy
      name: '@xiaoyilin/dsh-mcp-lazy'
      config:
        transport: streamable-http
        serverName: remote-api
        url: http://127.0.0.1:8000/mcp
        headers: {}
```

### 配置项

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `transport` | `stdio` \| `streamable-http` | — | 必填。MCP 传输方式。 |
| `serverName` | string | — | 必填。允许 `[A-Za-z0-9_-]{1,32}`，同时用作工具名前缀。 |
| `command` / `args` / `env` / `cwd` | — | — | `stdio` 启动参数。`env` 会合并到脱敏后的父进程环境。 |
| `url` / `headers` | — | — | `streamable-http` 的服务地址和请求头。 |
| `toolCallTimeoutMs` | number | `60000` | 单次工具调用超时，单位为毫秒。 |
| `autoActivate` | boolean | `false` | 启动时直接连接服务器。开启后不再按需加载。 |
| `releaseOnTurnEnd` | boolean | `true` | 本轮结束且没有会话继续使用时，自动断开服务器并卸载工具。 |

## 工作原理

1. 每个服务器先注册 `mcp__<server>__activate` 和 `mcp__<server>__deactivate` 两个控制工具。
2. 调用 `activate` 后，插件通过 `stdio` 或 `streamable-http` 连接服务器，分页读取 `tools/list`，再注册服务器提供的全部工具。
3. 工具名沿用 `dsh-mcp-client` 的规则：`mcp__<server>__<tool>`。名称只保留 `[A-Za-z0-9_-]`，最长 64 个字符；出现冲突时追加 12 位哈希。
4. 默认在 `agent/turn-stopping` 时释放本轮占用。`agent/disposed` 负责处理会话直接结束的情况。
5. 收到 `tools/list/changed` 后会重新同步工具。连接意外断开时，插件会立即卸载旧工具；再次调用 `activate` 即可恢复。

## 限制

- 不支持必须以任务方式执行的工具，即 `tool.execution.taskSupport === 'required'`。遇到这类工具会直接返回错误。
- 连接断开后不会自动重连。按需模式下，重新调用 `activate` 更可控，也不会让闲置服务器在后台反复启动。
- TOKEN 数据是工具定义的近似值，不代表请求的全部输入，也不能直接换算成账单金额。

## 许可证

MIT
