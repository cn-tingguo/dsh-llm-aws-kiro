[English](README.md) | 中文

# dsh-llm-kiro-local

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 LLM 接入层提供 Kiro 提供方。

本包是 [joshryandavis/dsh-llm-aws-kiro](https://github.com/joshryandavis/dsh-llm-aws-kiro) 的本地
fork，已迁移到 harness 0.2.x 的消息模型和包线。本 fork 的改动提交在上游历史之上，因此
`git fetch upstream && git merge upstream/main` 仍然可用。

该包是一个独立的 Cordis 插件：通过 `cordis.yml` 挂载到任意 harness 组合中，在 `ctx.llm` 上注册 `kiro`
提供方路由，无需改动 harness 本身。

## 它处理什么

| 关注点 | 实现 |
| --- | --- |
| **现有凭据** | 自动拾取已有的 kiro-cli 登录（kiro-cli SQLite 存储的 `auth_kv` 表，IDC 和社会登录 token）以及
  Kiro IDE token（`~/.aws/sso/cache/kiro-auth-token.json` 及其 OIDC 客户端注册）——无需二次登录。可选的
  `bearerTokenEnv` 引用可绕过环境发现，供 CI/机器人使用。 |
| **Token 刷新** | 通过 AWS SSO OIDC `/token` 端点（Builder ID / IAM Identity Center）或 Kiro 桌面认证服务
  （Google/GitHub 社会登录）静默刷新过期 token，并写回 kiro-cli 存储，保证两个使用方保持同步。流中途
  收到 403 时先重新读取共享存储，再直接刷新，最后回退到 `kiro-cli whoami --format json`——该命令会认证
  当前会话并轮换过期 token。每条刷新通道都有超时上限。最后的兜底失败以 `MISSING_CREDENTIAL`/AUTH
  及指引形式呈现。 |
| **后端** | 区域/端点解析（SSO 区域 → Kiro API 区域）、管理控制面（`List-Available-Profiles`、
  `List-Available-Models`、共享的 `~/.kiro-management-models-cache.json` 目录缓存），以及通过 AWS
  event-stream 协议（经 `@smithy/core` 的 Smithy 组帧）发起的运行时 `generateAssistantResponse` 调用，
  带容量退避、首 token 超时和 harness 空闲看门狗。 |
| **模型** | 一份镜像 kiro-cli 已验证菜单的引导目录（21 个模型，含上下文窗口、输出上限、推理能力、图像模态），
  精确的线上 id 解析（带连字符的 harness id ⇄ 带点的线上 id），以及经过认证的管理目录：它会刷新所服务的元数据，
  并追加引导清单发布之后才上线的模型——不仅作用于 Models 页面，也直接作用于模型选择器。
  选择器把 `auto` 放在首位，其余按额度倍率从大到小排列，倍率直接显示在标签里；认证目录不再收录的模型
  会被移除，而不是继续提供。
  推理强度选择器提供 `off` 以及每个模型认证 effort schema 中的档位（如 `low`/`medium`/`high`/`xhigh`/`max`），
  并在系统提示上带上 Kiro 的思考标记。 |

每个运行时请求都携带 harness 属性化的 `User-Agent`（来自 `@deepseek-ai/dsh-llm` 的
`attributionHeaders()`），以及后端期望的 AWS SDK 风格的 `x-amz-user-agent` 遥测头。

harness 0.2.x 由 `SettingsForms` 自行投射插件的 `Config` schema，因此本提供方在 `ctx.llm` 上注册可配置
路由，不再自行安装设置区。插件配置仍来自它的 `cordis.patch.yml` 条目。

## 图标与署名

`icon.svg` 是 Kiro 的官方标记，从 https://kiro.dev/icon.svg 下载。"Kiro" 及其标记是 Amazon Web
Services 的商标；此处使用该图标仅用于标识本插件连接的产品。若以不同品牌再分发，请替换它。

## 安装

该包是 ESM，并把所依赖的 harness 包声明为 peer dependencies——由宿主 DSH 安装提供。它还声明了 `dsh`
bundle 清单（`cordis.patch.yml` 随包发布），因此既可以作为普通插件依赖挂载，也可以作为 profile bundle 挂载。

```bash
dsh plugin --profile <profile> add dsh-llm-kiro-local
```

在 `cordis.yml` 中挂载：

```yaml
- id: llm-kiro
  name: 'dsh-llm-kiro-local'
  config:
    region: us-east-1        # 可选；省略时以凭据的区域为准
    reasoningEffort: high    # 可选；off | low | medium | high | xhigh | max（默认 high）
```

对于已有的 kiro-cli 或 Kiro IDE 登录，这已经是全部配置：凭据被自动拾取、静默刷新并写回。静态 bearer token
也可以：

```yaml
- id: llm-kiro
  name: 'dsh-llm-kiro-local'
  config:
    bearerTokenEnv: KIRO_BEARER_TOKEN   # 通过 harness 凭据服务存储
```

## 配置参考

所有字段都可选。插件配置来自它在 `cordis.patch.yml` 中的条目；harness 的设置界面会读取同一套 `Config`
schema。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `region` | 凭据的区域，否则 `us-east-1` | Kiro API 区域覆盖。 |
| `runtimeURL` | `https://runtime.<region>.kiro.dev` | 运行时端点覆盖，用于网关/代理部署。 |
| `profileArn` | 管理发现 | Profile ARN 覆盖。 |
| `bearerTokenEnv` | — | 静态 bearer token 的凭据引用；绕过环境发现。 |
| `thinking` | `enabled` | 部署锁；设为 `disabled` 会把每个请求都限制为 `off`。 |
| `reasoningEffort` | `high` | 默认推理强度；`off` 禁用思考。模型不支持的档位取最近的档位。 |
| `maxTokens` | `8192` | 默认的每请求输出上限；按模型的上限和显式值优先。 |
| `defaultContextWindow` | `200000` | 没有精确值时的上下文容量。 |
| `models` | 引导目录 + 认证发现 | 显式模型列表；非空时原样提供并关闭发现。 |
| `streamIdleTimeoutMs` | `300000` | 每次读取的空闲预算。 |
| `firstTokenTimeoutMs` | `90000` | 首事件预算；慢模型另有按模型覆盖。 |
| `retryPolicy` | normal，五次重试 | 提供给 `dsh-llm-retry` 的提供方自有重试策略。 |
| `kiroCliDbPath` | 平台应用支持目录 | kiro-cli SQLite 存储覆盖。 |
| `ssoCacheDir` | `~/.aws/sso/cache` | Kiro IDE token 目录覆盖。 |
| `allowKiroCliRefresh` | `true` | 403 恢复是否允许调用 `kiro-cli`。 |

`models` 的每个条目支持：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `id` | 必填 | 选择器中显示的 harness 模型 id（带连字符，如 `claude-sonnet-4-6`）。 |
| `kiroModelId` | 由 `id` 推导 | 运行时接受的精确线上 id（带点，如 `claude-sonnet-4.6`）。 |
| `name` | `id` | 选择器标签。 |
| `reasoning` | `false` | 该模型是否输出推理内容。 |
| `contextWindow` | `200000` | 请求与响应的合计容量。 |
| `maxTokens` | `8192` | 每请求输出上限。 |
| `inputModalities` | `['text']` | 接受的模态；含 `image` 即允许图像输入。 |
| `firstTokenTimeoutMs` | 全局默认 | 为较慢模型设置更长的首事件预算。 |

## 模型

引导目录（harness id → 线上 id）：

| Harness id | 线上 id | 上下文 | 推理 | 图像 |
| --- | --- | --- | --- | --- |
| `claude-opus-5-5` / `claude-opus-5` | `claude-opus-5.5` / `claude-opus-5` | 1M | ✓ | ✓ |
| `claude-opus-4-8` / `claude-opus-4-7` | `claude-opus-4.8` / `claude-opus-4.7` | 1M | ✓ | ✓ |
| `claude-opus-4-6` / `claude-opus-4-5` | `claude-opus-4.6` / `claude-opus-4.5` | 1M / 200K | ✓ | ✓ |
| `claude-sonnet-5` / `claude-sonnet-4-6` | `claude-sonnet-5` / `claude-sonnet-4.6` | 1M | ✓ | ✓ |
| `claude-sonnet-4-5` / `claude-sonnet-4` | `claude-sonnet-4.5` / `claude-sonnet-4` | 200K | ✓ | ✓ |
| `claude-haiku-4-5` | `claude-haiku-4.5` | 200K | ✗ | ✓ |
| `claude-fable-5` | `claude-fable-5` | 1M | ✓ | ✓ |
| `gpt-5-6-sol` / `gpt-5-6-terra` / `gpt-5-6-luna` | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | 1M | ✓ | ✗ |
| `deepseek-3-2` | `deepseek-3.2` | 164K | ✓ | ✗ |
| `minimax-m2-5` / `minimax-m2-1` | `minimax-m2.5` / `minimax-m2.1` | 196K | ✗ | ✗ |
| `glm-5` | `glm-5` | 200K | ✓ | ✗ |
| `qwen3-coder-next` | `qwen3-coder-next` | 256K | ✓ | ✗ |
| `auto` | `auto` | 1M | ✓ | ✓ |

带连字符和带点的两种写法都会解析到线上 id。引导清单是发现之前的回退项；经过认证的管理目录
（`List-Available-Models`，按凭据、按区域）会刷新已匹配条目的容量、推理强度阶梯、推理元数据和额度倍率，
并追加引导清单尚未收录的模型。显式配置的非空 `models` 列表会完全替代发现，并按其作者书写的顺序原样提供。

发现会直达 harness 模型选择器：读取模型列表时立即返回缓存内容，并在后台为下一次读取刷新缓存，因此管理
端点缓慢或不可达都不会拖慢选择器或请求。

一旦拿到经过认证的目录，它在两处具有权威性：

- **下线的模型会被移除。** 目录不再收录的条目会被移除，而不是在没有倍率的情况下继续提供，因为选中它会
  在请求时失败。若尚未抓取过目录，则不判定任何条目下线。
- **选择器按成本排序。** `auto` 排在最前，其余按额度倍率从大到小排列，倍率显示在标签里
  （`Claude Sonnet 5 · 1.3x`）。目录未定价的模型只显示名称，并排在最后。

`~/.kiro-management-models-cache.json` 的目录缓存与 pi-provider-kiro 共享：该工具写入格式版本 1，
本提供方读取该布局，并写入版本 2。缓存条目保留 8 小时后才会重新抓取；删除该文件可立即强制刷新。

## 开发

```bash
pnpm install
pnpm run build       # tsc -b：编译本包；依赖从固定版本的 @deepseek-ai 包解析
pnpm test            # vitest 套件（121 个测试）：端点、存储、刷新、模型、推理强度、序列化、
                     # 翻译、适配器传输、真实 Loader 组合
```

测试套件锁定了那些一旦回归很难察觉的行为：选择器顺序、8 小时缓存边界、目录下线模型的剔除规则，以及每条
传输通道发出的请求体。

测试从 `node_modules` 中的 `@deepseek-ai/*` 包解析 harness 包（peer dependencies 加上按代码开发所针对
版本固定的 dev-dependency 集合），因此它们验证的是确切发布的 API。凭据测试与宿主机器真实的 kiro-cli /
Kiro IDE 存储完全隔离。

## 已知限制

一处真实的缺口，真需要时可以补：

- **未捆绑交互式登录。** 没有环境凭据时，提供方以 `MISSING_CREDENTIAL` 失败，并指向 `kiro-cli login`
  或 Kiro IDE。设备码流程可以日后在管理接缝上补充。现有引导已覆盖常规情形，因此这是便利性缺口，不是
  阻塞问题。

## 已评估但不做

以下各项都经过评估并有意识地保留现状，记录在此以免有人把它当作 bug 重新排查。

- **模型名旁的倍率徽章。** composer 渲染 `conversation.input.model.label`，本插件曾按官方 model-label
  插件的形态写了一个客户端半边，但在 link 安装的包上它的注册始终未生效：入口加载未导致启动失败，而槽位
  仍只有内置占用者。因此倍率显示在模型名里。先后试过三种实现；要进一步定位需要浏览器控制台，宿主侧拿
  不到。可见的成本信息是等价的，区别只在样式。
- **不发出回放状态。** 跟进时历史会以提供方无关的内容重新发送。这是与其他 adapter 一致的设计选择，不是
  限制——Kiro 后端并不要求回放状态。
- **目录刷新是拉取式的，并非定时任务。** 读取模型列表时返回缓存或引导目录，并为下一次读取刷新缓存，因此
  新上线的模型要等到下一次刷新才出现——最多比目录变更晚 8 小时。改成定时任务需要引入计时器和额外失败
  路径，而这份菜单极少变动。
- **模型的新鲜度取决于上一次刷新是否成功。** 引导清单刻意不收录最新条目，以保持目录的权威性；缓存缺失或
  过期期间这些模型会一直隐藏，直到刷新成功。若要改为「过期也先展示旧数据」，下线判断还需要同时考虑数据
  年龄，改动量超过该场景的收益。

## 已验证、但容易被误认为有问题的行为

以下结论来自 kiro-cli 2.36.0 上的实测，而非推测：

- **推理通过原生事件到达。** 由 `thinkingText` 和 `thinkingSignature` 承载；像 `auto` 这种内部分派的
  模型则完全不发推理事件，而不是把 `<thinking>` 标签内联到可见内容里。所有测过的模型都没有出现内联方言。
- **每条刷新通道都有超时上限。** AWS SSO OIDC、Kiro 桌面认证服务和 `kiro-cli whoami` 兜底各自受超时
  约束，认证端点挂起时只会让该层失败，不会拖住整个回合。
- **下线的模型会被移除，而不是继续提供。** 一旦读取过认证目录，目录不再收录的条目就会被移除；若尚未读取
  过目录，则不判定任何条目下线。

## 许可证

MIT
