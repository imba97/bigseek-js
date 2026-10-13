import type { SearchEngineKind, SearchHit } from '../types'

/**
 * Worker 消息契约（主线程 ↔ Worker）。
 *
 * 设计上 URL 不走消息：它在 Worker 入口里就是静态可知的（构建期常量），
 * 只有「什么时候开始加载」需要主线程说一声，所以只有 `preload`。
 */

/** 主线程 → Worker */
export interface PreloadMessage {
  type: 'preload'
}

export interface QueryMessage {
  type: 'search'
  keywords: string
  tag: string | null
  category: string | null
  limit: number
  /** 自增请求号，用于丢弃过期结果 */
  requestId: number
}

export type SearchRequestMessage = PreloadMessage | QueryMessage

/** Worker → 主线程 */
export interface ReadyMessage {
  type: 'ready'
  engine: SearchEngineKind
  /** 引擎规模（文档数 / 词条数 / 分面数），便于日志排查 */
  stats: Record<string, number>
}

export interface ErrorMessage {
  type: 'error'
  message: string
}

export interface ResultMessage {
  type: 'searchResult'
  hits: SearchHit[]
  requestId: number
}

export type SearchResponseMessage = ReadyMessage | ErrorMessage | ResultMessage
