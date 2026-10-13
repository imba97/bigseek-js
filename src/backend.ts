import type { SearchEngineKind, SearchHit } from './types'

/** 后端查询入参：字段已在协议层归一（`tag` / `category` 为 null 表示不限） */
export interface BackendQuery {
  keywords: string
  tag: string | null
  category: string | null
  limit: number
}

/** 可插拔的检索引擎后端（wasm 主路径 / MiniSearch 回退路径都实现它） */
export interface SearchBackend {
  readonly engine: SearchEngineKind
  search: (query: BackendQuery) => SearchHit[]
}
