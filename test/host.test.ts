import type { SearchBackend } from '../src/backend'
import type { QueryMessage, SearchRequestMessage, SearchResponseMessage } from '../src/index'
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, serveSearch } from '../src/index'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/** 假 Worker 作用域：只管收集 Worker → 主线程的消息 */
function createScope() {
  const listeners: Array<(event: { data: unknown }) => void> = []
  const sent: SearchResponseMessage[] = []
  return {
    sent,
    scope: {
      postMessage: (message: unknown) => {
        sent.push(message as SearchResponseMessage)
      },
      addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => {
        listeners.push(listener)
      }
    },
    /** 模拟主线程发消息给 Worker */
    post: (message: SearchRequestMessage) => {
      for (const listener of listeners)
        listener({ data: message })
    }
  }
}

function stubBackend(search: SearchBackend['search'], engine: SearchBackend['engine'] = 'minisearch'): SearchBackend {
  return { engine, search }
}

describe('worker 侧宿主（serveSearch）', () => {
  it('preload 后上报 ready，且所有消息都带协议版本', async () => {
    const { scope, sent, post } = createScope()
    serveSearch({
      scope,
      engine: 'minisearch',
      fallback: () => stubBackend((q) => {
        return q.keywords === '有' ? [{ path: '/a', title: 'a', date: '', snippet: '', tags: [], categories: [] }] : []
      })
    })

    post({ type: 'preload', v: PROTOCOL_VERSION })
    await tick()

    expect(sent.map(message => message.type)).toEqual(['ready'])
    expect(sent.every(message => message.v === PROTOCOL_VERSION)).toBe(true)
    expect(sent[0]).toMatchObject({ type: 'ready', engine: 'minisearch' })

    // search 也能拿到结果
    post({ type: 'search', v: PROTOCOL_VERSION, keywords: '有', tag: null, category: null, limit: 10, requestId: 7 })
    await tick()
    expect(sent.at(-1)).toMatchObject({ type: 'searchResult', requestId: 7 })
  })

  it('没收到 preload 也能直接查询（内部先就绪）', async () => {
    const { scope, sent, post } = createScope()
    serveSearch({ scope, engine: 'minisearch', fallback: () => stubBackend(() => []) })

    post({ type: 'search', v: PROTOCOL_VERSION, keywords: 'x', tag: null, category: null, limit: 10, requestId: 1 })
    await tick()

    expect(sent.map(message => message.type)).toEqual(['ready', 'searchResult'])
  })

  it('同一批请求只回最后一个（latest-wins）', async () => {
    const { scope, sent, post } = createScope()
    const seen: string[] = []
    serveSearch({
      scope,
      engine: 'minisearch',
      fallback: () => stubBackend((q) => {
        seen.push(q.keywords)
        return []
      })
    })

    post({ type: 'search', v: PROTOCOL_VERSION, keywords: '第一个', tag: null, category: null, limit: 10, requestId: 1 })
    post({ type: 'search', v: PROTOCOL_VERSION, keywords: '第二个', tag: null, category: null, limit: 10, requestId: 2 })
    await tick()

    const results = sent.filter(message => message.type === 'searchResult')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ requestId: 2 })
    expect(seen).toContain('第二个')
  })

  it('后端查询抛异常时返回空结果，而不是让请求悬着', async () => {
    const { scope, sent, post } = createScope()
    serveSearch({
      scope,
      engine: 'minisearch',
      fallback: () => stubBackend(() => {
        throw new Error('wasm RuntimeError')
      })
    })

    post({ type: 'search', v: PROTOCOL_VERSION, keywords: 'x', tag: null, category: null, limit: 10, requestId: 42 })
    await tick()

    expect(sent.at(-1)).toMatchObject({ type: 'searchResult', requestId: 42, hits: [] })
  })

  it('初始化失败只上报一次，后续查询不再重试工厂（需要显式 reload）', async () => {
    const { scope, sent, post } = createScope()
    let factoryCalls = 0
    serveSearch({
      scope,
      engine: 'minisearch',
      fallback: () => {
        factoryCalls += 1
        throw new Error('语料 404')
      }
    })

    post({ type: 'preload', v: PROTOCOL_VERSION })
    await tick()
    expect(sent.filter(m => m.type === 'error')).toHaveLength(1)
    expect(factoryCalls).toBe(1)

    // 连续 5 次查询：不应再触发任何后端构建
    for (let i = 0; i < 5; i++) {
      post({ type: 'search', v: PROTOCOL_VERSION, keywords: `q${i}`, tag: null, category: null, limit: 10, requestId: i })
      await tick()
    }
    expect(factoryCalls).toBe(1)
    expect(sent.filter(m => m.type === 'error')).toHaveLength(1)

    // 每次查询仍然回包（空结果），主线程不会挂起
    expect(sent.filter(m => m.type === 'searchResult')).toHaveLength(5)
  })

  it('reload 会丢弃旧后端并重新构建', async () => {
    const { scope, sent, post } = createScope()
    let factoryCalls = 0
    serveSearch({
      scope,
      engine: 'minisearch',
      fallback: () => {
        factoryCalls += 1
        return stubBackend(() => [])
      }
    })

    post({ type: 'preload', v: PROTOCOL_VERSION })
    await tick()
    expect(factoryCalls).toBe(1)

    post({ type: 'reload', v: PROTOCOL_VERSION })
    await tick()
    expect(factoryCalls).toBe(2)
    expect(sent.filter(m => m.type === 'ready')).toHaveLength(2)
  })

  it('协议版本不匹配直接报错，不当作正常请求处理', async () => {
    const { scope, sent, post } = createScope()
    serveSearch({ scope, engine: 'minisearch', fallback: () => stubBackend(() => []) })

    post({ type: 'search' } as unknown as QueryMessage)
    await tick()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'error' })
    expect((sent[0] as { message: string }).message).toContain('协议版本不匹配')
  })

  it('没有 wasm 也没有 fallback 时报错并回空结果', async () => {
    const { scope, sent, post } = createScope()
    serveSearch({ scope, engine: 'auto' })

    post({ type: 'search', v: PROTOCOL_VERSION, keywords: 'x', tag: null, category: null, limit: 10, requestId: 3 })
    await tick()

    const error = sent.find(m => m.type === 'error')
    expect(error).toBeDefined()
    expect((error as { message: string }).message).toContain('fallback')
    expect(sent.at(-1)).toMatchObject({ type: 'searchResult', requestId: 3, hits: [] })
  })
})
