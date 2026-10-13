/** 一条检索结果。字段与 bigseek 的 wasm 侧约定一致（`src/wasm.rs` 里手工拼的那 8 个字段）。 */
export interface SearchHit {
  path: string
  title: string
  date: string
  /** 正文命中摘要；纯范围浏览（只给 tag / category，没有关键词）时为空串 */
  snippet: string
  tags: string[]
  categories: string[]
}

/** 查询条件。`tag` / `category` 传空表示不限定范围。 */
export interface SearchQuery {
  keywords: string
  tag?: string | null
  category?: string | null
  /** 返回条数上限，默认 40，上限 200 */
  limit?: number
}

/** wasm 侧返回的原始命中项：比 `SearchHit` 多 `score` / `exact`（一般不需要） */
export interface WasmSearchHit extends SearchHit {
  score: number
  exact: boolean
}

/** 索引格式版本，与 wasm 侧的 `FORMAT_VERSION` 对应 */
export const SUPPORTED_FORMAT_VERSION = 1

export const SEARCH_LIMIT_DEFAULT = 40
export const SEARCH_LIMIT_MAX = 200

/** 生效的检索引擎 */
export type SearchEngineKind = 'wasm' | 'minisearch'
