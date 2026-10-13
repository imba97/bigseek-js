/**
 * bigseek 的浏览器端客户端：加载 wasm 检索内核、在 Worker 里托管查询、
 * 并在 wasm 不可用时回退到 MiniSearch。
 *
 * 这个包只做「调用」这件事：索引的生成（`build-index`）与 wasm 产物的编译都在
 * bigseek 仓库里完成，产物通过 GitHub Release 分发。
 */

// 类型与常量
export type {
  BackendQuery,
  SearchBackend
} from './backend'
// 回退引擎（内部动态 import minisearch，不用就不会被加载）
export type { MiniSearchFallbackOptions, MiniSearchRecord } from './fallback/minisearch'

export { createMiniSearchFallback } from './fallback/minisearch'
// 与 Rust 侧逐字对齐的分词器（回退路径必须用它，否则中文召回会掉到 39.7%）
export { isCjkLike, miniSearchTokenizer, normalizeForSearch, tokenizeForSearch } from './tokenize'
export type {
  SearchEngineKind,
  SearchHit,
  SearchQuery,
  WasmSearchHit
} from './types'
export { resolveLimit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SUPPORTED_FORMAT_VERSION } from './types'
export type { WasmSearchIndex, WasmSearchModule } from './wasm/glue'

// 直接在主线程用（不用 Worker）
export type { BigseekIndex, CreateIndexOptions } from './wasm/index'
export { createIndex, toSearchHit } from './wasm/index'

// Worker 托管 + 主线程客户端
export type { CreateSearchClientOptions, SearchClient, SearchClientState, WorkerLike } from './worker/client'

export { createSearchClient } from './worker/client'
export type { SearchWorkerScope, ServeSearchOptions } from './worker/host'
export { serveSearch } from './worker/host'
export type {
  ErrorMessage,
  PreloadMessage,
  QueryMessage,
  ReadyMessage,
  ReloadMessage,
  ResultMessage,
  SearchRequestMessage,
  SearchResponseMessage
} from './worker/protocol'
export { PROTOCOL_VERSION } from './worker/protocol'
