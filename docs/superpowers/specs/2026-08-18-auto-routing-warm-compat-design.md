# 自动路由、连接保温与 DSH 兼容层设计

## 背景

`@xiaoyilin/dsh-mcp-lazy` 0.3.0 已能按需连接 MCP、动态注册工具、处理目录变更并有限重连，但仍有三个使用成本：模型必须记住先调用每个服务器的 `activate`；轮末释放后下一轮会重新启动服务器；插件实现直接依赖 DSH 的 `ctx.tools`、事件和 effect 生命周期。

本设计把这三个问题作为一个 0.4.0 版本交付，因为它们共享同一条状态链：路由器选择服务器，服务器运行时管理连接和工具发布，DSH 适配器负责把运行时接入宿主。

## 目标

1. 常驻一个共享的 `mcp__router__search_and_activate` 工具，让模型用自然语言查找并激活最匹配的 MCP，减少遗漏显式 `activate` 的概率。
2. 轮次结束时立即卸载工具 Schema，但默认保留 MCP 连接 5 分钟；再次使用时从内存目录恢复工具，不重新启动子进程。
3. 把所有 DSH 专有调用收口到适配器，并对 DSH `0.1.0-rc.6`、`0.1.0-rc.7` 建立自动兼容验证。
4. 保持现有 transport、超时、分页、刷新回滚、有限重连和显式 activate/deactivate 配置兼容。

## 非目标

- 不注册每个远端工具的常驻占位代理；这会重新引入大量 Schema token。
- 不用一个无类型的 `call(server, tool, args)` 取代原生工具；激活后仍由模型调用完整 JSON Schema 的原生工具。
- 不在 0.4.0 写磁盘工具目录缓存。目录可能包含敏感名称且跨版本失效复杂；本版本只在 DSH 进程内缓存原始目录。
- 不实现跨进程的使用预测，也不保证第一次冷启动没有延迟。
- 不新增管理 UI。

## 方案比较

### 方案 A：常驻所有工具的轻量代理

模型直接调用代理时自动连接，最不容易忘记激活。但每个工具仍需暴露名称和参数，token 收益明显下降；精简参数又会损失调用质量，因此不采用。

### 方案 B：统一无类型调用工具

只保留一个 `call`，上下文最小，自动连接也容易。但模型看不到原生参数 Schema，复杂工具的参数正确率会下降，因此不采用。

### 方案 C：共享搜索激活工具加原生动态工具

常驻一个带类型的搜索工具。它只负责选择和激活服务器，完成后由 DSH 把该服务器的原生工具加入后续模型步骤。该方案多一次轻量路由调用，但保留 token 收益和原生调用质量，因此采用。

## 架构

### 1. DSH 适配器

新增 `lib/dsh-adapter.js`，导出 `createDshAdapter(ctx)`。插件其他模块只依赖以下稳定接口：

- `registerTool(definition): dispose`
- `on(event, handler)`
- `effect(factory, label)`
- `log(level, message)`
- `identity`：同一 DSH 工具注册域共享的对象，用作路由器注册表的 WeakMap 键

适配器启动时探测 `ctx.tools.register`、`ctx.on` 和 `ctx.effect`。配置实例遇到不兼容宿主时记录一条包含缺失能力的错误并返回 `supported: false`，`apply` 随即安全退出，不抛异常拖垮整个 DSH 插件树。无配置的 DSH 自动插入实例继续直接 no-op。

适配器不依赖 DSH 私有版本字段；行为由能力探测决定。版本矩阵负责提前发现语义变化。

### 2. 共享路由器

新增 `lib/tool-router.js`。模块用 `WeakMap<adapter.identity, RouterRegistry>` 保证同一 DSH 工具域只注册一个 `mcp__router__search_and_activate`。

每个 lazy MCP 实例向注册表登记：

- `serverName`
- 配置的 `routingHints: string[]`
- 最近一次成功发现的原始工具名称和描述
- `activate(agent, signal)` 回调
- 销毁时使用的注销函数

路由工具参数为：

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "serverName": { "type": "string" }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

路由顺序是确定性的：

1. `serverName` 精确命中时直接选择。
2. query 包含完整 `mcp__<server>__` 前缀时精确选择。
3. 对小写后的 serverName、routingHints、缓存工具名称和描述做词项及子串评分。
4. 唯一最高分且分数大于零时激活该服务器。
5. 零分或最高分并列时不激活，只返回最多 5 个候选服务器，防止误加载。

路由结果只报告选择的服务器、激活结果和少量匹配工具名称，不返回完整 Schema 或服务器配置。激活完成后，原生工具由 DSH 正常加入工具目录。

现有 `mcp__<server>__activate` 和 `deactivate` 保留，兼容明确指定服务器的调用和人工运维。

### 3. 单服务器运行时与连接保温

新增 `lib/server-runtime.js`，把 `index.js` 中的可变状态迁入一个单服务器运行时。运行时区分三个概念：

- `client`：MCP 传输连接是否存在
- `catalog`：最近一次验证成功的原始工具目录，进程内保留
- `registrations`：当前发布给 DSH/模型的工具 Schema

新增配置：

```yaml
warmIdleMs: 300000
routingHints: ['浏览器', '页面调试', 'network']
```

`warmIdleMs` 默认 `300000`。设为 `0` 时恢复 0.3.0 的轮末立即断开行为。

状态流如下：

1. 冷激活：建立连接，发现并验证目录，写入 catalog，发布工具。
2. 轮次结束：立即卸载 registrations；若 `warmIdleMs > 0`，保留 client 并启动保温计时器。
3. 保温期再次激活：取消计时器，用 catalog 重新发布工具，不重启服务器、不重复 `tools/list`。
4. 保温期收到 `tools/list/changed`：刷新并替换 catalog；没有活跃使用者时不把工具重新发布到 DSH。
5. 保温超时：关闭 client，但保留 catalog 的名称和描述供路由评分；下次激活重新连接并重新发现目录。
6. 显式 deactivate、插件销毁：立即卸载工具并关闭连接，不等待保温计时器。
7. 意外断线：立即卸载工具。只有存在活跃使用者或 `autoActivate` 时才按预算重连；单纯处于保温状态不后台重连。

`releaseOnTurnEnd: false` 继续保持工具发布和连接，不进入保温状态。`autoActivate: true` 继续在启动时连接并发布工具。

0.4.0 不实现全局 LRU。当前配置只有真正使用过的服务器才进入保温，默认 5 分钟后释放；若实际资源数据证明同时保温过多，再增加全局上限，避免先引入跨实例抢占复杂度。

## 数据与安全

- catalog 只存 MCP 返回的工具名称、描述和 Schema，保存在内存，不落盘。
- 路由索引不包含 command、args、env、headers、URL 或调用结果。
- 日志继续使用已有脱敏父进程环境；新增日志不得输出配置对象。
- 路由器不能在并列或零分时猜测服务器。

## 错误处理

- 路由器没有候选时返回可操作提示，不修改任何实例状态。
- 候选并列时返回候选 serverName 和 routingHints 摘要，不自动激活。
- 路由激活失败时原样返回经过现有错误格式化的激活结果，不尝试其他服务器。
- catalog 刷新失败保留最后一次可用目录；保温状态下同样适用。
- 重新发布 catalog 任一工具失败时回滚到发布前状态。
- DSH 能力缺失时单实例 no-op 并记录错误，宿主仍能启动。

## 配置兼容与版本

- 现有配置无需修改即可运行。
- 新增 `routingHints`，默认空数组；没有提示时仍可用 serverName 和已缓存目录路由。
- 新增 `warmIdleMs`，默认 300000；这是 0.4.0 的连接资源行为变化，但工具 Schema 仍在轮末立即卸载。
- package 版本升级为 `0.4.0`。
- README 明确区分“工具卸载”和“连接关闭”，并给出 `warmIdleMs: 0` 的旧行为迁移方式。

## 文件边界

- `lib/index.js`：配置 Schema、transport/executor 构造和插件装配；不再直接管理全部生命周期状态。
- `lib/server-runtime.js`：单实例连接、目录、发布、保温、重连和释放状态机。
- `lib/tool-router.js`：共享注册表、确定性评分、搜索并激活工具。
- `lib/dsh-adapter.js`：DSH 能力探测及稳定宿主接口。
- `lib/lazy-core.js`：保留纯目录发现、指纹、协调和注册回滚算法。
- `test/router.test.mjs`：评分、精确命中、并列拒绝、共享注册和注销。
- `test/dsh-adapter.test.mjs`：支持及不支持宿主能力的行为。
- `test/fixtures/plugin-host-harness.mjs`：真实 MCP fixture 的保温、目录刷新、重连和显式关闭集成测试。
- `.github/workflows/test.yml`：Node.js 20/24 单元矩阵与 DSH rc.6/rc.7 兼容 smoke job。

## 测试与验收

自动化测试必须证明：

1. 同一工具域的多个实例只注册一个路由工具，最后一个实例销毁后路由工具注销。
2. exact serverName、完整工具前缀和唯一关键词会激活正确实例；并列和零分不会激活。
3. 第一次激活启动 fixture；轮末工具立即消失；保温期再次激活不增加进程启动计数。
4. 保温超时后再次激活会增加启动计数。
5. 保温时的目录变更更新 catalog 但不重新发布工具。
6. 显式 deactivate 和插件销毁立即关闭进程并清理计时器。
7. DSH 能力缺失不会抛出导致宿主启动失败的异常。
8. 原有分页、目录回滚、有限重连、调用中止和 0.3.0 配置测试继续通过。
9. CI 在 Node.js 20、24 运行完整测试，并分别针对 DSH 0.1.0-rc.6、0.1.0-rc.7 执行宿主兼容 smoke。

本机最终验收使用正式 `http://127.0.0.1:3080/`：新会话通过路由工具自然语言激活 fixture，调用 echo；结束一轮后验证工具卸载但启动计数不变；下一轮重新路由并调用；等待短测试 TTL 后验证冷重启；最后显式 deactivate、删除 fixture 配置并确认正式 8 个 lazy MCP、模型选择和 Chrome 控制台恢复正常。

## 成功标准

- 模型面对未加载 MCP 时只需一个共享路由入口，不必记住服务器专用 activate。
- 保温期内重复使用同一 MCP 不重启子进程，同时非活跃轮次不携带其完整工具 Schema。
- DSH 不兼容升级不会使整个插件树启动失败，并在 CI 或启动能力探测中给出明确证据。
- 不降低原生工具 Schema 质量，不扩大敏感配置暴露面，现有用户配置继续有效。
