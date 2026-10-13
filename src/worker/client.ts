import type { SearchEngineKind, SearchHit, SearchQuery } from '../types'
import type { QueryMessage, SearchRequestMessage, SearchResponseMessage } from './protocol'
import { SEARCH_LIMIT_DEFAULT } from '../types'

/**
 * Worker 的最小接口。真 `Worker` 满足它；测试里给个假对象也能跑。
 * 这里刻意不依赖 DOM 类型，方便在 Node（SSR / 测试）里引用本模块。
 */
export interface WorkerLike {
  postMessage: (message: unknown) => void
  addEventListener?: (type: string, listener: (event: any) => void) => void
  removeEventListener?: (type: string, listener: (event: any) => void) => void
  onmessage?: ((event: { data: unknown }) => void) | null
  onerror?: ((event: { message?: string }) => void) | null
  onmessageerror?: ((event: unknown) => void) | null
  terminate?: () => void
}

export interface SearchClientState {
  ready: boolean
  error: string | null
  engine: SearchEngineKind | null
  stats: Record<string, number> | null
}

export interface CreateSearchClientOptions {
  /**
   * Worker 实例或工厂。
   *
   * 工厂返回 `null` 表示当前环境用不了（典型是 SSR）：此时 `ensureReady()` 立即 resolve、
   * `search()` 返回空数组，调用方不必自己判断环境。
   * 传工厂而不是 URL，是因为各打包器创建 Worker 的写法不同（Vite 的 `new URL(..., import.meta.url)`、
   * webpack 的 `new Worker(new URL(...))` 等），这件事留给调用方最省事。
   */
  worker: WorkerLike | (() => WorkerLike | null)
  /** 构造后立刻预加载（默认 false：等第一次 `ensureReady()` 或 `search()`） */
  preload?: boolean
  /** 打印引擎与错误信息，默认 false */
  debug?: boolean
  log?: (message: string, ...args: unknown[]) => void
}

export interface SearchClient {
  /** 只读状态快照；变化通过 `subscribe` 通知（Vue 侧包一层 ref 即可） */
  readonly state: SearchClientState
  /** 预加载并等待就绪；可重复 await */
  ensureReady: () => Promise<void>
  /** 查询；同一时刻只认最后一次调用的结果，过期的 Promise 以空数组结束 */
  search: (query: SearchQuery) => Promise<SearchHit[]>
  subscribe: (listener: (state: SearchClientState) => void) => () => void
  dispose: () => void
}

class SearchClientImpl implements SearchClient {
  readonly state: SearchClientState = {
    ready: false,
    error: null,
    engine: null,
    stats: null
  }

  private worker: WorkerLike | null = null
  private workerCreated = false
  private readyTask: Promise<void> | null = null
  private readyTaskResolve: (() => void) | null = null
  private readyTaskReject: ((error: Error) => void) | null = null
  private searchRequestId = 0
  private pendingLatest: { requestId: number, resolve: (hits: SearchHit[]) => void } | null = null
  private listeners = new Set<(state: SearchClientState) => void>()

  constructor(private readonly options: CreateSearchClientOptions) {
    if (options.preload)
      void this.ensureReady()
  }

  private log(message: string, ...args: unknown[]): void {
    if (this.options.log)
      this.options.log(message, ...args)
    else if (this.options.debug)
      console.warn(message, ...args)
  }

  private notify(): void {
    for (const listener of this.listeners)
      listener(this.state)
  }

  subscribe(listener: (state: SearchClientState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  ensureReady(): Promise<void> {
    if (this.state.ready)
      return Promise.resolve()
    if (this.readyTask)
      return this.readyTask

    const worker = this.getWorker()
    if (!worker)
      return Promise.resolve()

    this.state.error = null
    this.readyTask = new Promise<void>((resolve, reject) => {
      this.readyTaskResolve = resolve
      this.readyTaskReject = reject
    })

    const message: SearchRequestMessage = { type: 'preload' }
    worker.postMessage(message)
    return this.readyTask
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    await this.ensureReady()

    const worker = this.getWorker()
    if (!worker)
      return []

    const requestId = ++this.searchRequestId
    const message: QueryMessage = {
      type: 'search',
      keywords: query.keywords,
      tag: query.tag ?? null,
      category: query.category ?? null,
      limit: query.limit ?? SEARCH_LIMIT_DEFAULT,
      requestId
    }

    return new Promise<SearchHit[]>((resolve) => {
      // 上一个还没回来的查询已经过期，直接以空数组结束，避免它悬着
      this.resolvePendingWithEmpty()
      this.pendingLatest = { requestId, resolve }
      worker.postMessage(message)
    })
  }

  dispose(): void {
    this.resolvePendingWithEmpty()
    this.detachWorker()
    this.listeners.clear()
  }

  private getWorker(): WorkerLike | null {
    if (this.workerCreated)
      return this.worker

    this.workerCreated = true
    this.worker = typeof this.options.worker === 'function'
      ? this.options.worker()
      : this.options.worker

    if (this.worker)
      this.attachWorker(this.worker)
    return this.worker
  }

  private attachWorker(worker: WorkerLike): void {
    if (worker.addEventListener) {
      worker.addEventListener('message', this.onMessageEvent)
      worker.addEventListener('error', this.onErrorEvent)
      worker.addEventListener('messageerror', this.onMessageErrorEvent)
      return
    }

    worker.onmessage = this.onMessageEvent
    worker.onerror = this.onErrorEvent
    worker.onmessageerror = this.onMessageErrorEvent
  }

  private detachWorker(): void {
    const worker = this.worker
    if (!worker)
      return

    if (worker.removeEventListener) {
      worker.removeEventListener('message', this.onMessageEvent)
      worker.removeEventListener('error', this.onErrorEvent)
      worker.removeEventListener('messageerror', this.onMessageErrorEvent)
    }
    else {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
    }

    worker.terminate?.()
    this.worker = null
  }

  private onMessageEvent = (event: { data: unknown }): void => {
    this.dispatch(event.data)
  }

  private onErrorEvent = (event: { message?: string }): void => {
    this.handleFatal(event?.message || '搜索 Worker 运行异常')
  }

  private onMessageErrorEvent = (): void => {
    this.handleFatal('搜索 Worker 消息格式错误')
  }

  private dispatch(data: unknown): void {
    if (!data || typeof data !== 'object')
      return
    const message = data as SearchResponseMessage

    if (message.type === 'ready') {
      this.state.ready = true
      this.state.error = null
      this.state.engine = message.engine
      this.state.stats = message.stats ?? null
      this.notify()
      this.log(`[bigseek] 引擎就绪：${message.engine}`)
      this.resolveReadyTask()
      return
    }

    if (message.type === 'error') {
      this.handleErrorMessage(message.message)
      return
    }

    if (message.type === 'searchResult') {
      if (this.pendingLatest?.requestId !== message.requestId)
        return
      const { resolve } = this.pendingLatest
      this.pendingLatest = null
      resolve(message.hits)
    }
  }

  private handleErrorMessage(message: string): void {
    this.state.error = message
    this.state.ready = false
    this.notify()
    this.log(`[bigseek] ${message}`)
    this.readyTaskReject?.(new Error(message))
    this.clearReadyTaskReferences()
    this.resolvePendingWithEmpty()
  }

  private handleFatal(message: string): void {
    this.handleErrorMessage(message)
    this.detachWorker()
  }

  private resolvePendingWithEmpty(): void {
    if (!this.pendingLatest)
      return
    this.pendingLatest.resolve([])
    this.pendingLatest = null
  }

  private resolveReadyTask(): void {
    this.readyTaskResolve?.()
    this.clearReadyTaskReferences()
  }

  private clearReadyTaskReferences(): void {
    this.readyTask = null
    this.readyTaskResolve = null
    this.readyTaskReject = null
  }
}

/**
 * 主线程侧客户端：建 Worker、等就绪、发查询、丢弃过期结果。
 *
 * ```ts
 * const client = createSearchClient({
 *   worker: () => import.meta.env.SSR
 *     ? null
 *     : new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })
 * })
 * ```
 */
export function createSearchClient(options: CreateSearchClientOptions): SearchClient {
  return new SearchClientImpl(options)
}
