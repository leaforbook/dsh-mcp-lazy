# @xiaoyilin/dsh-mcp-lazy

Lazy MCP bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): MCP servers connect **on demand** instead of at startup. Until a server is activated, only two lightweight control tools occupy the tool catalog — nothing else.

DSH 按需 MCP 桥接插件：MCP 服务器**按需激活**，不随启动常驻。平时工具目录里只有两个轻量控制工具，激活后才注册该服务器的全部工具。

## Why / 为什么

`@deepseek-ai/dsh-mcp-client` connects every configured MCP server at startup and keeps all their tools registered permanently. With several servers that means dozens of tools in the catalog on every turn — crowding the model's function list, burning context tokens, and holding idle child processes open.

`dsh-mcp-lazy` flips that around:

- Startup registers only `mcp__<server>__activate` / `mcp__<server>__deactivate` per configured server.
- When the model calls `activate`, the plugin connects that server and registers all of its tools; they are usable for the rest of the turn.
- By default (`releaseOnTurnEnd: true`), when a turn ends and no session is still using the server, the bridge disconnects and unregisters every tool. `agent/disposed` acts as a fallback release path.
- Accidental disconnects unregister tools automatically; calling `activate` again reconnects. No automatic reconnect (redundant cost in on-demand mode).

The tool naming, call semantics and result projection follow the same conventions as `@deepseek-ai/dsh-mcp-client`, so the model sees tools in a familiar shape.

## Install / 安装

```sh
dsh plugin --profile web add github:leaforbook/dsh-mcp-lazy
```

This project is distributed directly from GitHub and is not published to npm. / 本项目直接通过 GitHub 分发，不发布到 npm。

## Configure / 配置

Add one `- id: mcp-lazy` entry per MCP server in your profile's `cordis.patch.yml`:

在 profile 的 `cordis.patch.yml` 中为每个 MCP 服务器加一条 `- id: mcp-lazy` 条目：

```yaml
- insert:
    - id: mcp-lazy
      name: '@xiaoyilin/dsh-mcp-lazy'
      config:
        transport: stdio
        serverName: filesystem
        command: npx
        args: [-y, '@modelcontextprotocol/server-filesystem', '/tmp']
        autoActivate: false          # connect at startup instead (default false)
        releaseOnTurnEnd: true       # disconnect at end of turn (default true)

    - id: mcp-lazy
      name: '@xiaoyilin/dsh-mcp-lazy'
      config:
        transport: streamable-http
        serverName: remote-api
        url: http://127.0.0.1:8000/mcp
        headers: {}
```

### Config options / 配置项

| Key / 键 | Type / 类型 | Default / 默认 | Description / 说明 |
| --- | --- | --- | --- |
| `transport` | `stdio` \| `streamable-http` | — | Required. Transport for the MCP server. / 必填，MCP 传输方式。 |
| `serverName` | string | — | Required. `[A-Za-z0-9_-]{1,32}`; prefixes the control tools. / 必填，作为控制工具名前缀。 |
| `command` / `args` / `env` / `cwd` | — | — | stdio transport: process to spawn (`env` merges over the scrubbed parent env). / stdio 方式：启动命令（`env` 在脱敏父环境上合并）。 |
| `url` / `headers` | — | — | streamable-http transport: endpoint URL and headers. / HTTP 方式：端点与请求头。 |
| `toolCallTimeoutMs` | number | `60000` | Per-tool-call timeout. / 单次工具调用超时。 |
| `autoActivate` | boolean | `false` | Connect at startup instead of on demand. / 启动即连接（退回常驻模式）。 |
| `releaseOnTurnEnd` | boolean | `true` | Disconnect when the turn ends and no session is using the server. / 轮次结束且无会话使用时自动断开。 |

## How it works / 工作原理

1. Each configured server registers two control tools: `mcp__<server>__activate` and `mcp__<server>__deactivate`.
2. `activate` connects (stdio child process or streamable HTTP), fetches `tools/list` with pagination, and registers every tool under the same public-name contract as `dsh-mcp-client` (`mcp__<server>__<tool>`, sanitized to `[A-Za-z0-9_-]`, 64-char cap with a 12-hex hash on collision).
3. Tool use marks the calling agent as a user of that server; on `agent/turn-stopping` the agent is removed from the user set, and when the set empties the server disconnects and its tools unregister. `agent/disposed` always releases.
4. `tools/list/changed` re-syncs registered tools on the fly; a dropped connection unregisters everything and logs — call `activate` again to recover.

## Limitations / 限制

- Tools that require task-based execution (`tool.execution.taskSupport === 'required'`) are rejected with a clear error; the bridge does not implement task plumbing. / 声明必须任务化执行的工具会报错拒绝（桥接层不实现 task 管道）。
- No automatic reconnect — by design in on-demand mode. / 不做自动重连——按需模式下的刻意设计。

## License / 许可证

MIT
