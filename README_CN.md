# bigseek

**中文** · [English](./README.md)

[![npm](https://img.shields.io/npm/v/bigseek.svg)](https://www.npmjs.com/package/bigseek)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/actions/workflow/status/imba97/bigseek-js/release.yaml?label=Release)](https://github.com/imba97/bigseek-js/actions/workflows/release.yaml)
[![Types](https://img.shields.io/badge/types-included-blue.svg)](#api)

[bigseek](https://github.com/imba97/bigseek) 索引的浏览器端客户端：WebAssembly 查询引擎、
CJK bigram 分词器、可选的 MiniSearch 回退。

这个包只负责**调用**。索引的生成与 wasm 的编译都在
[bigseek](https://github.com/imba97/bigseek) 仓库完成，产物通过它的
[GitHub releases](https://github.com/imba97/bigseek/releases) 分发——客户端在运行期下载，
所以本包本身不含任何二进制。

## 目录

- [背景](#背景)
- [特性](#特性)
- [安装](#安装)
- [用法](#用法)
- [API](#api)
- [注意事项](#注意事项)
- [License](#license)

## 背景

按空白与标点切词的方案会把「一整句中文」当成一个词条，在 144 篇中文语料上文档级召回只有
**39.7%**，只有落在句首的词能搜到；bigseek 按 bigram 建索引，召回是 **100%**。

WebAssembly 索引是可降级的（产物缺失或加载失败），所以回退路径必须用同一套分词语义——
否则「降级」会静默变成「残废」。这就是分词器随包一起发的原因，而不是依赖回退引擎的默认分词。

## 特性

- **Worker 优先**：`serveSearch()` 在 Worker 里托管引擎，`createSearchClient()` 在主线程驱动它，
  两侧共用一份带版本握手的消息协议。
- **最后一次查询优先**：连续敲键会合并成一次结果，过期响应被丢弃而不是乱序渲染。
- **可选 MiniSearch 回退**：wasm 产物不可用时用 `createMiniSearchFallback()` 从文档 JSON 继续检索。
  `minisearch` 是动态 import 的，不用回退的消费者不会把它打进来。
- **格式版本校验**：`createIndex()` 拒绝格式版本不匹配的索引，把「crate 升了、客户端没升」
  变成明确报错，而不是静默返回空结果。
- **框架无关**：状态是普通快照对象 + `subscribe()` 回调，Vue / React / 原生 DOM 都能直接用。
- **降级可见**：超时、Worker 崩溃、已释放三种情况与「没有结果」可以区分。

## 安装

```bash
npm install bigseek
```

```bash
pnpm add bigseek
```

## 用法

### 在 Worker 里托管查询（推荐）

Worker 入口：

```ts
import { createMiniSearchFallback, serveSearch } from 'bigseek'

const base = import.meta.env.BASE_URL || '/'

serveSearch({
  wasm: {
    glueUrl: `${base}search/bigseek.js`,
    wasmUrl: `${base}search/bigseek_bg.wasm`,
    indexUrl: `${base}search/search.idx`
  },
  // 可选：wasm 产物缺失时继续提供搜索
  fallback: () => createMiniSearchFallback({ source: `${base}search-full.json` })
})
```

主线程：

```ts
import { createSearchClient } from 'bigseek'

const client = createSearchClient({
  worker: () => import.meta.env.SSR
    ? null
    : new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })
})

client.subscribe((state) => {
  // 每次变化都是新对象：`ref(client.state)` 直接可用
  console.log(state.ready, state.engine, state.error)
})

await client.ensureReady()
const hits = await client.search({ keywords: '性能优化', tag: 'rust', limit: 20 })
```

### 不用 Worker

```ts
import { createIndex } from 'bigseek'

const index = await createIndex({
  glueUrl: '/search/bigseek.js',
  wasmUrl: '/search/bigseek_bg.wasm',
  indexUrl: '/search/search.idx'
})

index.docCount // 144
index.termCount // 24154
index.facetCounts // [标签数, 分类数]
index.query({ keywords: '性能', tag: null, category: null, limit: 40 })
// → [{ path, title, date, snippet, tags, categories }]

index.dispose() // 用完后释放 wasm 侧索引
```

### 只用回退引擎

```ts
import { createMiniSearchFallback } from 'bigseek'

const backend = await createMiniSearchFallback({ source: '/search-full.json' })
backend.search({ keywords: '性能', tag: null, category: null, limit: 20 })
```

## API

### `serveSearch(options)`

在 Worker 里调用一次。后端在收到 `preload`（或第一次查询）时惰性加载。

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `wasm` | `CreateIndexOptions` | wasm 引擎的地址组 |
| `fallback` | `() => SearchBackend \| Promise<SearchBackend>` | wasm 不可用时使用的后端工厂 |
| `engine` | `'auto' \| 'wasm' \| 'minisearch'` | `auto`（默认）先试 wasm 再回退；其余强制单一引擎 |
| `scope` | `SearchWorkerScope` | 消息作用域，默认 `globalThis` |
| `log` | `(message, ...args) => void` | 日志出口 |

### `createSearchClient(options)`

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `worker` | `WorkerLike \| (() => WorkerLike \| null)` | Worker 实例或工厂；返回 `null`（如 SSR）时所有调用安全空转 |
| `preload` | `boolean` | 构造后立刻开始加载（默认 `false`） |
| `timeoutMs` | `number` | 单次查询超时，默认 `10000`；传 `0` 关闭 |
| `debug` / `log` | `boolean` / function | 打印引擎就绪与错误信息 |

`SearchClient` 成员：

| 成员 | 说明 |
| --- | --- |
| `state` | `{ ready, error, engine, stats, disposed, failed }` 快照 |
| `ensureReady()` | 预加载；就绪后 resolve，Worker 致命错误后 reject |
| `search(query)` | 最后一次优先的查询；被顶替的调用以 `[]` 结束 |
| `reload()` | 丢弃当前引擎并重新加载（显式重试） |
| `subscribe(listener)` | 订阅状态变化，返回取消订阅函数 |
| `dispose()` | 结算未完成的工作、解绑 Worker，之后调用一律空转 |

### `createIndex(options)`

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `glueUrl` / `wasmUrl` / `indexUrl` | `string` | `bigseek.js`、`bigseek_bg.wasm`、`search.idx` 的地址 |
| `expectedFormatVersion` | `number` | 要求的索引格式版本（默认取本包支持的版本） |
| `loadGlue` | `(url) => Promise<WasmSearchModule>` | 自定义 glue 加载（测试、自带打包） |
| `fetchImpl` | `typeof fetch` | 自定义 fetch（测试、非 HTTP 来源） |

返回 `BigseekIndex`：`docCount`、`termCount`、`formatVersion`、`facetCounts`、`query()`、
`dispose()`，以及底层 wasm 句柄 `raw`。

### `createMiniSearchFallback(options)`

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `source` | `string \| URL \| MiniSearchRecord[]` | 文档 JSON 的地址，或直接给记录数组 |
| `tokenize` | `(text) => string[]` | 覆盖分词器（默认用与 Rust 一致的 CJK bigram 分词器） |
| `searchOptions` | `object` | 透传给 MiniSearch |
| `snippetWindow` / `snippetMaxLength` | `number` | 摘要窗口 |

### 工具导出

| 导出 | 说明 |
| --- | --- |
| `miniSearchTokenizer`、`tokenizeForSearch`、`normalizeForSearch`、`isCjkLike` | 与 Rust 实现逐字对齐的分词器 |
| `resolveLimit(limit?)` | 把 limit 归一化到 `[1, 200]`；所有查询路径共用 |
| `SUPPORTED_FORMAT_VERSION`、`PROTOCOL_VERSION`、`SEARCH_LIMIT_DEFAULT`、`SEARCH_LIMIT_MAX` | 常量 |
| `SearchHit`、`SearchQuery`、`BigseekIndex`、`SearchClient` 等 | 类型（TypeScript 声明随包发布） |

## 注意事项

- **查询语义**：只认最后一次发起的查询，被顶替的调用以 `[]` 结束而不是竞速返回。
  `tag` / `category` 传 `null` 表示不限范围；`limit` 在所有引擎上都夹到 `[1, 200]`，
  wasm 与回退路径不可能给出不同解释。
- **失败处理**：后端查询抛异常时该请求返回空结果，而不是一直悬挂。引擎初始化失败后
  **不会**每次查询都重试（那会让每个按键都重新下载一遍语料），要重试请显式 `reload()`；
  查询超过 `timeoutMs` 会以空结果结束。
- **打包器差异**：`minisearch` 是动态 import——普通 Web 构建会拆成按需 chunk，
  而 Vite 的 Worker 构建（IIFE + `inlineDynamicImports`）会把它内联进 Worker 包（约 14 KiB）。
- **协议版本**：Worker 与客户端在每条消息上都带 `PROTOCOL_VERSION`，
  所以被缓存成旧版本的 Worker chunk 会得到明确报错，而不是永远等不到回包。
- **契约**：分词器与 Rust 实现共用同一份向量文件测试，因此两个引擎召回同一批文档。

## License

[MIT](./LICENSE)
