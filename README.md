# bigseek

[bigseek](https://github.com/imba97/bigseek) 索引的浏览器端客户端：WebAssembly 查询引擎 + CJK bigram 分词 + 可选的 MiniSearch 回退。

它只负责**调用**：索引怎么生成、wasm 怎么编译都在 bigseek 仓库里完成，产物通过 GitHub Release 分发。

## 为什么需要它

bigseek 的索引是按 **CJK bigram** 分词的，所以「最开始知道这个方法」能被「知道」命中。
MiniSearch 默认分词器按空白与标点切分，中文整句会变成一个词条，文档级召回只有 39.7% ——
所以回退路径**必须**共用同一套分词语义，否则「降级即残废」。这个包把分词器一起带上了，
并用 bigseek 的 `testdata/tokenize-vectors.json` 守住两侧一致。

## 安装

```bash
pnpm add bigseek
```

## 用法

### Worker 里托管查询（推荐）

Worker 入口（`search.worker.ts`）：

```ts
import { createMiniSearchFallback, serveSearch } from 'bigseek'

const base = import.meta.env.BASE_URL || '/'

serveSearch({
  wasm: {
    glueUrl: `${base}search/bigseek.js`,
    wasmUrl: `${base}search/bigseek_bg.wasm`,
    indexUrl: `${base}search/search.idx`
  },
  // 可选：wasm 不可用时用它继续提供搜索
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

// 状态是普通对象 + 订阅，框架无关（Vue 里包一层 ref 即可）
client.subscribe((state) => {
  console.log(state.ready, state.engine, state.error)
})

await client.ensureReady()
const hits = await client.search({ keywords: '性能优化', tag: 'rust', limit: 20 })
```

- 同一时刻只认**最后一次** `search()`，过期的调用以空数组结束；
- Worker 工厂返回 `null`（如 SSR）时全部安全空转，调用方不用自己判断环境；
- `search()` 会等 `ensureReady()`，不必手动先 await；
- 单次查询默认 10 秒超时（`timeoutMs`，传 0 关闭）：Worker 被 kill 或被 OOM 杀掉时
  不会让 UI 永远转圈；
- 引擎初始化失败**不会**每次查询都重试（否则每个按键都会重新拉一遍索引语料），
  要重试就显式 `client.reload()`；
- `client.state` 每次变化都是**新对象**，可直接 `ref(client.state)`；
  `disposed` / `failed` 分别表示「已释放」「Worker 致命错误」，致命错误后
  `ensureReady()` 与 `search()` 都以该错误 reject，而不是静默返回空结果。

### 不用 Worker

```ts
import { createIndex } from 'bigseek'

const index = await createIndex({
  glueUrl: '/search/bigseek.js',
  wasmUrl: '/search/bigseek_bg.wasm',
  indexUrl: '/search/search.idx'
})

index.docCount // 144
index.facetCounts // [标签数, 分类数]
index.query({ keywords: '性能', tag: null, category: null, limit: 40 })
// → [{ path, title, date, snippet, tags, categories }]
```

### 直接用回退引擎

```ts
import { createMiniSearchFallback } from 'bigseek'

const backend = await createMiniSearchFallback({ source: '/search-full.json' })
backend.search({ keywords: '性能', tag: null, category: null, limit: 20 })
```

`minisearch` 是**动态** import 的：不引用回退入口的消费者不会把它打进来。
打包器差异要注意：普通 Web 构建会把它拆成按需 chunk，而 Vite 的 Worker 构建
（默认 IIFE + `inlineDynamicImports`）无法代码分割，会内联进 worker 包（约 14 KiB）。

## 版本与 ABI

索引头部带格式版本，`createIndex()` 默认要求它与本库支持的版本一致，不一致直接抛错：

```
索引格式版本不匹配：索引是 v2，本库支持 v1
```

这条校验是防止「bigseek 升级了、客户端没升」这类漂移的运行时防线，
所以升级 bigseek 时要同步升级本包。

Worker 协议另外带一个 `PROTOCOL_VERSION`：Worker chunk 可能被浏览器/Service Worker
缓存成旧版本，版本不匹配时客户端会直接报错，而不是让查询永远等不到回包。

## 契约测试

```bash
pnpm test
```

- `test/tokenize.test.ts`：拿 `test/vectors/tokenize-vectors.json`（从 bigseek 同步）核对分词；
- `test/fallback.test.ts`：回退引擎的召回、范围过滤、摘要、错误分支，含「默认分词器会漏掉中文句中词」的对照组；
- `test/client.test.ts`：客户端状态机、requestId 对账、过期丢弃、超时、`reload`、协议版本、两种 Worker 事件绑定；
- `test/host.test.ts`：Worker 侧宿主的 ready/error 上报、latest-wins 合并、后端抛异常、初始化失败不重试、`reload`；
- `test/build-artifacts.test.ts`：直接断言 `dist/` 产物（minisearch 未被内联、导出面完整），未构建时跳过。

拿真实 wasm 产物验 ABI（仓库里不放二进制，默认跳过）：

```bash
BIGSEEK_WASM_DIR=/path/to/dir/with/pkg-and-idx pnpm test
```

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

发布走 tag：推 `v*` tag 后由 `.github/workflows/release.yaml` 用 npm Trusted Publisher（OIDC）发布，**不需要 NPM_TOKEN**。
（在 npm 后台配置 Trusted Publisher 时，Workflow filename 必须填 `release.yaml`。）

## License

[MIT](./LICENSE)
