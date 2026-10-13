import type { QueryMessage, SearchHit } from '../src/index'
import { describe, expect, it } from 'vitest'
import { createSearchClient } from '../src/index'

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

describe('主线程客户端', () => {
  it('ensureReady 发出 preload 并等 ready', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })
    const states: boolean[] = []
    client.subscribe(state => states.push(state.ready))

    const ready = client.ensureReady()
    expect(worker.posted).toEqual([{ type: 'preload' }])
    expect(client.state.ready).toBe(false)

    worker.emit({ type: 'ready', engine: 'wasm', stats: { docCount: 3, termCount: 9 } })
    await ready

    expect(client.state.ready).toBe(true)
    expect(client.state.engine).toBe('wasm')
    expect(client.state.stats).toEqual({ docCount: 3, termCount: 9 })
    expect(states).toEqual([true])
  })

  it('search 带自增 requestId，并按 requestId 对账结果', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })
    const ready = client.ensureReady()
    worker.emit({ type: 'ready', engine: 'wasm', stats: {} })
    await ready

    const pending = client.search({ keywords: '性能', tag: 'rust', category: null })
    await tick()

    const [message] = worker.searchMessages()
    expect(message).toMatchObject({
      type: 'search',
      keywords: '性能',
      tag: 'rust',
      category: null,
      requestId: 1
    })
    expect(message.limit).toBe(40)

    worker.emit({ type: 'searchResult', requestId: message.requestId, hits: [hit('/posts/a')] })
    await expect(pending).resolves.toEqual([hit('/posts/a')])
  })

  it('只认最后一次查询，过期的那次以空数组结束', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })
    const ready = client.ensureReady()
    worker.emit({ type: 'ready', engine: 'wasm', stats: {} })
    await ready

    const first = client.search({ keywords: '旧' })
    await tick()
    const second = client.search({ keywords: '新' })
    await tick()

    expect(worker.searchMessages().map(message => message.requestId)).toEqual([1, 2])

    // 第一次已经过期：直接以空数组结束，不等 worker 回包
    await expect(first).resolves.toEqual([])

    // 迟到的旧结果必须被丢弃
    worker.emit({ type: 'searchResult', requestId: 1, hits: [hit('/posts/stale')] })
    worker.emit({ type: 'searchResult', requestId: 2, hits: [hit('/posts/fresh')] })
    await expect(second).resolves.toEqual([hit('/posts/fresh')])
  })

  it('worker 报 error 时置错误态并让 ensureReady 拒绝', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })
    const ready = client.ensureReady()

    worker.emit({ type: 'error', message: '索引加载失败' })

    await expect(ready).rejects.toThrow('索引加载失败')
    expect(client.state.ready).toBe(false)
    expect(client.state.error).toBe('索引加载失败')
  })

  it('worker 致命错误会终止并释放实例', async () => {
    const worker = new PropWorker()
    const client = createSearchClient({ worker })
    const ready = client.ensureReady()

    worker.emitFatal('运行异常')

    await expect(ready).rejects.toThrow('运行异常')
    expect(worker.terminated).toBe(true)

    // 释放后再查询应安全空转
    await expect(client.search({ keywords: 'x' })).resolves.toEqual([])
  })

  it('工厂返回 null（SSR）时全部安全空转', async () => {
    const client = createSearchClient({ worker: () => null })
    await expect(client.ensureReady()).resolves.toBeUndefined()
    await expect(client.search({ keywords: 'x' })).resolves.toEqual([])
    expect(client.state.ready).toBe(false)
    expect(client.state.error).toBeNull()
  })

  it('支持 addEventListener 风格并能在 dispose 时解绑', async () => {
    const worker = new ListenerWorker()
    const client = createSearchClient({ worker })

    const ready = client.ensureReady()
    expect(worker.listenerCount()).toBe(3)
    worker.emit({ type: 'ready', engine: 'minisearch', stats: {} })
    await ready
    expect(client.state.engine).toBe('minisearch')

    client.dispose()
    expect(worker.listenerCount()).toBe(0)
    expect(worker.terminated).toBe(true)
  })

  it('preload 选项会立刻预加载', async () => {
    const worker = new PropWorker()
    createSearchClient({ worker, preload: true })
    await tick()
    expect(worker.posted).toEqual([{ type: 'preload' }])
  })
})
