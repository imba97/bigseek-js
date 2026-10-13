import type { BackendQuery, SearchBackend } from '../backend'
import type { CreateIndexOptions } from '../wasm/index'
import type { QueryMessage, SearchRequestMessage, SearchResponseMessage } from './protocol'
import { createIndex } from '../wasm/index'
import { PROTOCOL_VERSION } from './protocol'

/** Worker 侧最小作用域：真 Worker 的 `self`、测试里的假对象都能满足 */
export interface SearchWorkerScope {
  postMessage: (message: unknown) => void
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void
}

export interface ServeSearchOptions {
  /** wasm 索引地址组；与 `fallback` 至少给一个 */
  wasm?: CreateIndexOptions
  /** 回退后端工厂：只在需要时调用（`engine: 'minisearch'` 或 wasm 失败时） */
  fallback?: () => SearchBackend | Promise<SearchBackend>
  /** `auto`（默认）先试 wasm、失败回退；`wasm` 强制；`minisearch` 强制走回退 */
  engine?: 'auto' | 'wasm' | 'minisearch'
  /** 接收消息的作用域，默认 `globalThis`（Worker 里即 `self`） */
  scope?: SearchWorkerScope
  /** 日志出口，默认静默 */
  log?: (message: string, ...args: unknown[]) => void
}

function wasmStats(index: Awaited<ReturnType<typeof createIndex>>): Record<string, number> {
  return {
    docCount: index.docCount,
    termCount: index.termCount,
    tagCount: index.facetCounts[0] ?? 0,
    categoryCount: index.facetCounts[1] ?? 0
  }
}

class SearchHost {
  private backend: SearchBackend | null = null
  private stats: Record<string, number> = {}
  private initTask: Promise<void> | null = null
  /** 初始化失败过：不再每次查询都重来一遍，必须显式 `reload` */
  private initFailed = false
  private initErrorMessage: string | null = null

  // latest-wins：同一帧内只把最后一个请求的结果发回去
  private queued: QueryMessage | null = null
  private flushScheduled = false
  private flushRunning = false

  constructor(
    private readonly options: ServeSearchOptions,
    private readonly emit: (message: SearchResponseMessage) => void
  ) {}

  handle(raw: unknown): void {
    if (!raw || typeof raw !== 'object')
      return
    const message = raw as SearchRequestMessage
    // 版本握手：旧 Worker chunk 与新版主线程混用时直接拒绝，而不是沉默
    if (message.v !== PROTOCOL_VERSION) {
      this.emit({
        type: 'error',
        v: PROTOCOL_VERSION,
        message: `搜索 Worker 协议版本不匹配：收到 v${message.v}，本 Worker 是 v${PROTOCOL_VERSION}`
      })
      return
    }

    if (message.type === 'preload') {
      void this.ensureBackend()
      return
    }

    if (message.type === 'reload') {
      this.backend = null
      this.initTask = null
      this.initFailed = false
      this.initErrorMessage = null
      this.stats = {}
      this.log('[bigseek] reload：丢弃当前引擎并重新加载')
      void this.ensureBackend(true)
      return
    }

    if (message.type === 'search') {
      // 没收到 preload 也要能用：先确保后端就绪，再按 latest-wins 排队
      void this.ensureBackend().then(() => this.enqueueLatest(message))
    }
  }

  private log(message: string, ...args: unknown[]): void {
    this.options.log?.(message, ...args)
  }

  private async buildWasm(): Promise<SearchBackend | null> {
    if (!this.options.wasm)
      return null
    const index = await createIndex(this.options.wasm)
    this.stats = wasmStats(index)
    return {
      engine: 'wasm',
      search: (query: BackendQuery) => index.query(query)
    }
  }

  private async buildFallback(): Promise<SearchBackend> {
    if (!this.options.fallback)
      throw new Error('wasm 引擎不可用，且没有提供 fallback 后端')
    return await this.options.fallback()
  }

  private async createBackend(): Promise<SearchBackend> {
    const preferred = this.options.engine ?? 'auto'

    if (preferred === 'minisearch')
      return await this.buildFallback()

    try {
      const wasm = await this.buildWasm()
      if (wasm)
        return wasm
      if (preferred === 'wasm')
        throw new Error('engine 为 wasm，但没有配置 wasm 索引地址')
    }
    catch (error) {
      if (preferred === 'wasm')
        throw error
      this.log('[bigseek] wasm 引擎不可用，回退 MiniSearch：', error)
    }

    return await this.buildFallback()
  }

  /**
   * 确保后端可用。
   *
   * 失败后**不自动重试**：否则每个按键都会重新拉一遍 wasm 三件套或整份
   * `search-full.json` 并重建回退索引（后者是几百毫秒 + MB 级流量），
   * 同时每条错误还会再通知一次主线程。重试只走显式 `reload`。
   */
  private ensureBackend(force = false): Promise<void> {
    if (this.backend)
      return Promise.resolve()
    if (this.initTask && !force)
      return this.initTask
    if (this.initFailed && !force)
      return Promise.resolve()

    this.initTask = (async () => {
      try {
        this.backend = await this.createBackend()
        this.initFailed = false
        this.initErrorMessage = null
        this.emit({
          type: 'ready',
          v: PROTOCOL_VERSION,
          engine: this.backend.engine,
          stats: this.stats
        })
      }
      catch (error) {
        this.initFailed = true
        this.initErrorMessage = error instanceof Error ? error.message : String(error)
        this.emit({
          type: 'error',
          v: PROTOCOL_VERSION,
          message: this.initErrorMessage
        })
      }
    })()

    return this.initTask
  }

  private enqueueLatest(query: QueryMessage): void {
    this.queued = query
    if (this.flushScheduled)
      return

    this.flushScheduled = true
    queueMicrotask(() => this.flush())
  }

  private searchOne(query: QueryMessage): ReturnType<SearchBackend['search']> {
    if (!this.backend)
      return []
    try {
      return this.backend.search({
        keywords: query.keywords,
        tag: query.tag,
        category: query.category,
        limit: query.limit
      })
    }
    catch (error) {
      // 后端查询抛异常（wasm 里 Rust panic 会变成 RuntimeError）时绝不能让它逃出
      // microtask：那会让这个 requestId 永远不回包，主线程的 Promise 永久挂起
      this.log('[bigseek] 查询失败，本轮返回空结果：', error)
      return []
    }
  }

  private flush(): void {
    this.flushScheduled = false
    if (this.flushRunning)
      return

    this.flushRunning = true
    try {
      while (this.queued) {
        const current = this.queued
        this.queued = null

        const hits = this.searchOne(current)

        // 期间又来了更新的请求：这次结果已经过期，丢弃（主线程也是 latest-wins）
        if (this.queued)
          continue

        this.emit({ type: 'searchResult', v: PROTOCOL_VERSION, hits, requestId: current.requestId })
      }
    }
    finally {
      this.flushRunning = false
      if (this.queued && !this.flushScheduled) {
        this.flushScheduled = true
        queueMicrotask(() => this.flush())
      }
    }
  }
}

/**
 * 在 Worker 里托管查询。调用方只需在 Worker 入口里调一次：
 *
 * ```ts
 * serveSearch({
 *   wasm: {
 *     glueUrl: `${base}search/bigseek.js`,
 *     wasmUrl: `${base}search/bigseek_bg.wasm`,
 *     indexUrl: `${base}search/search.idx`
 *   },
 *   fallback: () => createMiniSearchFallback({ source: `${base}search-full.json` })
 * })
 * ```
 */
export function serveSearch(options: ServeSearchOptions): void {
  const scope = options.scope ?? (globalThis as unknown as SearchWorkerScope)
  const host = new SearchHost(options, message => scope.postMessage(message))

  scope.addEventListener('message', (event) => {
    host.handle(event.data)
  })
}
