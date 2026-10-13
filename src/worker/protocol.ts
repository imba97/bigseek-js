import type { SearchEngineKind, SearchHit } from '../types'

/**
 * Worker 消息契约（主线程 ↔ Worker）。
 *
 * 设计上 URL 不走消息：它在 Worker 入口里就是静态可知的（构建期常量），
 * 只有「什么时候开始加载」需要主线程说一声，所以只有 `preload` / `reload`。
 *
 * 所有消息都带 `v`：Worker chunk 可能被浏览器/Service Worker 缓存成旧版本，
 * 没有版本握手时新旧协议不匹配会表现为「查询永远不回包」。
 */
export const PROTOCOL_VERSION = 1

/** 主线程 → Worker：开始（或重试）加载索引 */
export interface PreloadMessage {
  type: 'preload'
  v: number
}

/** 主线程 → Worker：丢弃当前后端并重新加载（引擎失败后的显式重试） */
export interface ReloadMessage {
  type: 'reload'
  v: number
}

export interface QueryMessage {
  type: 'search'
  v: number
  keywords: string
  tag: string | null
  category: string | null
  limit: number
  /** 自增请求号，用于丢弃过期结果 */
  requestId: number
}

export type SearchRequestMessage = PreloadMessage | ReloadMessage | QueryMessage

/** Worker → 主线程 */
export interface ReadyMessage {
  type: 'ready'
  v: number
  engine: SearchEngineKind
  /** 引擎规模（文档数 / 词条数 / 分面数），便于日志排查 */
  stats: Record<string, number>
}

export interface ErrorMessage {
  type: 'error'
  v: number
  message: string
}

export interface ResultMessage {
  type: 'searchResult'
  v: number
  hits: SearchHit[]
  requestId: number
}

export type SearchResponseMessage = ReadyMessage | ErrorMessage | ResultMessage
