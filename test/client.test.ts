import type { QueryMessage, SearchHit } from '../src/index'
import { describe, expect, it } from 'vitest'
import { createSearchClient, PROTOCOL_VERSION } from '../src/index'

function hit(path: string): SearchHit {
  return { path, title: path, date: '', snippet: '', tags: [], categories: [] }
}

/** 只有 on* 属性的 Worker（走兼容分支） */
class PropWorker {
  posted: unknown[] = []
  terminated = false
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null
  onmessageerror: ((event: unknown) => void) | null = null

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(data: unknown): void {
    this.onmessage?.({ data })
  }

  emitReady(engine: 'wasm' | 'minisearch' = 'wasm', stats: Record<string, number> = {}): void {
    this.emit({ type: 'ready', v: PROTOCOL_VERSION, engine, stats })
  }

  emitResult(requestId: number, hits: SearchHit[]): void {
    this.emit({ type: 'searchResult', v: PROTOCOL_VERSION, hits, requestId })
  }

  emitError(message: string): void {
    this.emit({ type: 'error', v: PROTOCOL_VERSION, message })
  }

  emitFatal(message: string): void {
    this.onerror?.({ message })
  }

  searchMessages(): QueryMessage[] {
    return this.posted.filter((m): m is QueryMessage => (m as QueryMessage).type === 'search')
  }
}

/** 用 addEventListener 的 Worker（走标准分支） */
class ListenerWorker {
  posted: unknown[] = []
  terminated = false
  private listeners = new Map<string, Set<(event: any) => void>>()

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values())
      total += set.size
    return total
  }

  emit(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? [])
      listener({ data })
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function readyClient(worker: PropWorker) {
  const client = createSearchClient({ worker })
  const ready = client.ensureReady()
  worker.emitReady('wasm', { docCount: 3, termCount: 9 })
  await ready
  return client
}

describe('主线程客户端', () => {
  it('ensureReady 发出带协议版本的 preload 并等 ready', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })
    const states: boolean[] = []
    client.subscribe(state => states.push(state.ready))

    const ready = client.ensureReady()
    expect(worker.posted).toEqual([{ type: 'preload', v: PROTOCOL_VERSION }])
    expect(client.state.ready).toBe(false)

    worker.emitReady('wasm', { docCount: 3, termCount: 9 })
    await ready

    expect(client.state.ready).toBe(true)
    expect(client.state.engine).toBe('wasm')
    expect(client.state.stats).toEqual({ docCount: 3, termCount: 9 })
    expect(states).toEqual([true])
  })

  it('state 每次变化都换新对象（基于引用比较的响应式不会失效）', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })
    const seen: unknown[] = []
    client.subscribe(state => seen.push(state))

    const ready = client.ensureReady()
    worker.emitReady()
    await ready
    worker.emitError('boom')

    expect(seen.length).toBeGreaterThanOrEqual(2)
    // 引用变化才能让 `ref(client.state)` / shallowRef 这类写法感知到更新
    expect(seen[1]).not.toBe(seen[0])
    expect(seen[0]).toMatchObject({ ready: true })
    expect(seen[1]).toMatchObject({ ready: false, error: 'boom' })
  })

  it('search 带自增 requestId 与归一化 limit，并按 requestId 对账结果', async () => {
    const worker = new PropWorker()
    const client = await readyClient(worker)

    const pending = client.search({ keywords: '性能', tag: 'rust', category: null, limit: 1000 })
    await tick()

    const [message] = worker.searchMessages()
    expect(message).toMatchObject({
      type: 'search',
      v: PROTOCOL_VERSION,
      keywords: '性能',
      tag: 'rust',
      category: null,
      requestId: 1
    })
    // limit 超上限时与 wasm / 回退路径同样夹到 200
    expect(message.limit).toBe(200)

    worker.emitResult(message.requestId, [hit('/posts/a')])
    await expect(pending).resolves.toEqual([hit('/posts/a')])
  })

  it('只认最后一次查询，过期的那次以空数组结束', async () => {
    const worker = new PropWorker()
    const client = await readyClient(worker)

    const first = client.search({ keywords: '旧' })
    await tick()
    const second = client.search({ keywords: '新' })
    await tick()

    expect(worker.searchMessages().map(message => message.requestId)).toEqual([1, 2])
    await expect(first).resolves.toEqual([])

    worker.emitResult(1, [hit('/posts/stale')])
    worker.emitResult(2, [hit('/posts/fresh')])
    await expect(second).resolves.toEqual([hit('/posts/fresh')])
  })

  it('查询超时后返回空结果，不会永久挂起', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker, timeoutMs: 20 })
    const ready = client.ensureReady()
    worker.emitReady()
    await ready

    const pending = client.search({ keywords: '慢' })
    await tick()
    await expect(pending).resolves.toEqual([])
  })

  it('worker 报 error 时置错误态并让 ensureReady 拒绝', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })
    const ready = client.ensureReady()

    worker.emitError('索引加载失败')

    await expect(ready).rejects.toThrow('索引加载失败')
    expect(client.state.ready).toBe(false)
    expect(client.state.error).toBe('索引加载失败')
  })

  it('preload 遇到 worker 报错不会产生未处理的 rejection', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker, preload: true })
    await tick()

    // 这里如果内部没有 catch，vitest 会把 unhandled rejection 报成失败
    worker.emitError('启动失败')
    await tick()
    await tick()

    expect(client.state.error).toBe('启动失败')
  })

  it('worker 致命错误后 ensureReady 以同一错误拒绝，且不再重建', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })
    const ready = client.ensureReady()

    worker.emitFatal('运行异常')

    await expect(ready).rejects.toThrow('运行异常')
    expect(worker.terminated).toBe(true)
    expect(client.state.failed).toBe(true)

    // 已死：不再尝试新建 Worker，也不静默返回空结果
    await expect(client.ensureReady()).rejects.toThrow('运行异常')
    await expect(client.search({ keywords: 'x' })).rejects.toThrow('运行异常')
  })

  it('协议版本不匹配视为致命错误', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })
    const ready = client.ensureReady()

    worker.emit({ type: 'ready', v: PROTOCOL_VERSION + 1, engine: 'wasm', stats: {} })

    await expect(ready).rejects.toThrow('协议版本不匹配')
    expect(client.state.failed).toBe(true)
  })

  it('reload 会重置状态并重新握手', async () => {
    const worker = new PropWorker()
    const client = await readyClient(worker)
    expect(client.state.ready).toBe(true)

    const reloading = client.reload()
    await tick()
    expect(worker.posted.at(-1)).toMatchObject({ type: 'reload', v: PROTOCOL_VERSION })
    expect(client.state.ready).toBe(false)

    worker.emitReady('minisearch')
    await reloading
    expect(client.state.ready).toBe(true)
    expect(client.state.engine).toBe('minisearch')
  })

  it('工厂返回 null（SSR）时全部安全空转', async () => {
    const client = createSearchClient({ worker: () => null })
    await expect(client.ensureReady()).resolves.toBeUndefined()
    await expect(client.search({ keywords: 'x' })).resolves.toEqual([])
    expect(client.state.ready).toBe(false)
    expect(client.state.error).toBeNull()
    expect(client.state.failed).toBe(false)
  })

  it('支持 addEventListener 风格并能在 dispose 时解绑', async () => {
    const worker = new ListenerWorker()
    const client = createSearchClient({ worker })

    const ready = client.ensureReady()
    expect(worker.listenerCount()).toBe(3)
    worker.emit({ type: 'ready', v: PROTOCOL_VERSION, engine: 'minisearch', stats: {} })
    await ready

    client.dispose()
    expect(worker.listenerCount()).toBe(0)
    expect(worker.terminated).toBe(true)
    expect(client.state.disposed).toBe(true)
    await expect(client.search({ keywords: 'x' })).resolves.toEqual([])
  })

  it('ready 之前 dispose 不会让 ensureReady 悬着', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })

    const ready = client.ensureReady()
    client.dispose()

    await expect(ready).resolves.toBeUndefined()
    expect(client.state.disposed).toBe(true)
    expect(client.state.ready).toBe(false)
  })

  it('preload 选项会立刻预加载', async () => {
    const worker = new PropWorker()
    createSearchClient({ worker, preload: true })
    await tick()
    expect(worker.posted).toEqual([{ type: 'preload', v: PROTOCOL_VERSION }])
  })
})
