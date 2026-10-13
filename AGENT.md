# 在这个仓库里工作

这里的每一条都是踩过之后写下来的：先犯错、找到证据、再修。没有核实过的结论不写进来。
改任何东西之前先读这一页。

## 这是什么

[bigseek](https://github.com/imba97/bigseek) 索引的浏览器端客户端：WebAssembly 查询引擎、
CJK bigram 分词器、可选的 MiniSearch 回退。本包只负责**调用**——索引的生成与 wasm 的编译都在
bigseek 仓库完成，产物通过它的 GitHub Release 分发，运行期下载。产品文档在
[`README.md`](./README.md) / [`README_CN.md`](./README_CN.md)。

| 目录 | 职责 |
| --- | --- |
| `src/wasm/index.ts` | `createIndex()`：加载 glue + wasm + 索引，包一层 `BigseekIndex`（`query` / `dispose`） |
| `src/worker/host.ts` | Worker 侧的 `serveSearch()`：惰性加载、失败熔断、latest-wins 合并 |
| `src/worker/client.ts` | 主线程 `createSearchClient()`：状态订阅、requestId 对账、超时、`reload()` |
| `src/worker/protocol.ts` | 消息类型与 `PROTOCOL_VERSION` |
| `src/fallback/minisearch.ts` | 文档 JSON 回退；`minisearch` 是动态 import |
| `src/tokenize.ts` | 与 Rust 逐字对齐的分词器（由契约向量锁定） |
| `src/types.ts` | 公开类型、`SUPPORTED_FORMAT_VERSION`、`resolveLimit` |
| `src/index.ts` | 导出面（改这里要同步 README 的 API 表） |
| `test/` | 契约与行为测试；`test/vectors/` 是从 bigseek 同步的向量 |
| `.github/workflows/release.yaml` | tag → checks → `pnpm publish`（OIDC）→ changelog |

## 一次任务做完，跑 CI 同款检查

**一次任务的所有 commit 完成后（推送前）**，把下面这四条跑一遍。`release.yaml` 里的
Typecheck / Test / Build 就是它们；本地不跑，等于把红灯留给 CI。

| # | 命令 | 对应 `release.yaml` |
| --- | --- | --- |
| 1 | `pnpm run lint` | （本地门禁：eslint，连 markdown 一起 lint） |
| 2 | `pnpm run typecheck` | Typecheck |
| 3 | `pnpm test` | Test |
| 4 | `pnpm run build` | Build |

- **先 build 再 test**：`test/build-artifacts.test.ts` 直接断言 `dist/` 的产物（minisearch 没被内联、
  导出面完整）。`dist/` 是 gitignore 的，没构建时那一组会静默跳过——CI 的顺序是 Test 先于 Build，
  所以它覆盖不到产物，本地要按「build → test」跑一遍才算真验过。
- **lint 覆盖 markdown**：README / AGENT.md 的改动也会被 `pnpm run lint` 检查。
- **wasm ABI 那组默认跳过**：它要真实产物（仓库里不放二进制）。要跑就指向一个同时含
  `bigseek.js` / `bigseek_bg.wasm` / `search.idx` 的目录：

  ```powershell
  $env:BIGSEEK_WASM_DIR='D:\Projects\imba97-blog-vite\public\search'; pnpm test
  ```

  ```bash
  BIGSEEK_WASM_DIR=/path/to/dir/with/pkg-and-idx pnpm test
  ```

  当前未跳过时是 55 个测试；跳过后是 51 个。数量变了要在这里同步。

## 两个版本号，别混

| 常量 | 位置 | 管什么 | 什么时候动 |
| --- | --- | --- | --- |
| `SUPPORTED_FORMAT_VERSION` | `src/types.ts` | **索引二进制格式**（由 bigseek crate 定义） | crate 改了格式就必须同步，并抬本包 minor |
| `PROTOCOL_VERSION` | `src/worker/protocol.ts` | **Worker ↔ 主线程的消息协议** | 只在握手本身变化时动；它的作用是让被缓存成旧版本的 worker chunk 给出明确报错，而不是让查询永远等不到回包 |

- 索引格式不匹配时 `createIndex()` 会抛出带版本号的错误（Rust 侧 `Index::load` 也会先拦一道），
  所以「crate 升了、客户端没升」不会静默变成空结果。
- 改分词器必须同步 `test/vectors/tokenize-vectors.json`（从 bigseek 同步），否则两侧语义会分叉，
  而回退路径的召回质量依赖它们一致。
- 破坏性变更在 0.x 下抬 minor（0.1.0 → 0.2.0）。本包 0.1.0 → 0.1.1 那次的 protocol 变更**不是**破坏性：
  收发两侧都在同一个包里，博客升一次版本即可。

## 发布

1. `pnpm run release`（bumpp 改版本）→ 提交 `chore: release vX.Y.Z`。
2. 打 tag `vX.Y.Z` 并推送。**`v*` tag 是唯一的触发器。**
3. `release.yaml`：Typecheck → Test → Build → `pnpm publish --access public --no-git-checks --provenance`
   → `changelogithub` 建 GitHub Release。

三条硬约束：

- **npm 的 Trusted Publisher 不能编辑，只能删掉重建**，而且其中的 **Workflow filename 必须与仓库里的
  文件名逐字一致**。本仓库从 `release.yml` 改名成 `release.yaml` 时就这样断过一次发布（仓库侧全绿、
  npm 上什么都没有）。改文件名后必须去 npm 后台删掉旧条目重建。
- **发布不可重来**：包名 + 版本号用过就占住了。所以顺序是 checks → publish → changelog，
  任一步失败都停在原地，不会留下「Release 建了、包没发」的不一致。
- **不需要 `NPM_TOKEN`**：走 GitHub OIDC。要验证发布成功，除了看版本号，还应确认 registry 元数据里
  有 `attestations` 字段（provenance 生效的证据）。

```bash
# 发布结果核对
curl -s https://registry.npmjs.org/bigseek/0.1.1 | grep -o '"attestations"'   # 有输出即 provenance 生效
curl -s https://registry.npmjs.org/bigseek | grep -o '"dist-tags":{[^}]*}'
```

## 本地与 CI 不一样的地方

| 现象 | 说明 |
| --- | --- |
| `pnpm install` 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | pnpm 12 的供应链政策拒绝太新的包。需要把包名加进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`；`minimumReleaseAgeExcludePrune` 必须**紧挨** `trustPolicy`（中间不能有空行），否则整块配置失效 |
| 本地能看到 `dist/` 的断言，CI 看不到 | `release.yaml` 的顺序是 Test → Build，见上文 |
| `npm pack` 里没有 `README_CN.md` | npm 只自动带上 `README.md`（以及 LICENSE / package.json）。改 `files` 字段后用 `npm pack --dry-run` 核对，别凭印象 |
| 真实 wasm 的 ABI 测试没跑 | 需要 `BIGSEEK_WASM_DIR`，见上 |

## 提交

Conventional Commits：英文、祈使语气、`type: 说明` 整行 ≤50 个 Unicode 字符、说明部分不加标点、
**不写 body**。一次任务按语义分组提交（`fix:` / `feat:` / `test:` / `docs:` / `chore:`）。
