import type { MiniSearchRecord } from '../src/fallback/minisearch'
import MiniSearch from 'minisearch'
import { describe, expect, it } from 'vitest'
import { createMiniSearchFallback } from '../src/fallback/minisearch'
import { miniSearchTokenizer } from '../src/tokenize'

const records: MiniSearchRecord[] = [
  {
    path: '/posts/rust-rewrite',
    title: '用 Rust 重写搜索',
    date: '2024-01-01',
    text: '最开始知道这个方法的时候，我觉得性能优化没那么重要。后来测了一下才发现差别很大。',
    tags: ['rust', 'search'],
    categories: ['技术']
  },
  {
    path: '/posts/vite-build',
    title: 'Vite 构建优化',
    date: '2024-02-02',
    text: '静态站点生成器的构建速度主要取决于依赖数量。',
    tags: ['vite', 'search'],
    categories: ['技术']
  },
  {
    path: '/posts/life',
    title: '生活记录',
    date: '2024-03-03',
    text: '今天去爬山了，天气不错。',
    tags: ['life'],
    categories: ['生活']
  }
]

async function createBackend() {
  return await createMiniSearchFallback({ source: records })
}

describe('回退后端（MiniSearch）', () => {
  it('中文句中词能命中（这正是换掉默认分词器的原因）', async () => {
    const backend = await createBackend()
    const hits = backend.search({ keywords: '知道', tag: null, category: null, limit: 10 })
    expect(hits.map(hit => hit.path)).toContain('/posts/rust-rewrite')
  })

  it('对照组：MiniSearch 默认分词器会漏掉同一个词', () => {
    // 用默认分词器（不传 tokenize）建一份同样的索引
    const mini = new MiniSearch({ fields: ['title', 'body'], storeFields: ['path'] })
    mini.addAll(records.map(record => ({
      id: record.path,
      title: record.title,
      body: record.text,
      path: record.path
    })))

    const hits = mini.search('知道', { combineWith: 'AND', prefix: true, fuzzy: 0.12 })
    expect(hits).toHaveLength(0)

    // 换成 bigram 分词器后同样的查询就能命中
    const withBigram = new MiniSearch({ fields: ['title', 'body'], storeFields: ['path'], tokenize: miniSearchTokenizer })
    withBigram.addAll(records.map(record => ({
      id: record.path,
      title: record.title,
      body: record.text,
      path: record.path
    })))
    expect(withBigram.search('知道', { combineWith: 'AND', prefix: true }).length).toBeGreaterThan(0)
  })

  it('没有关键词时按标签/分类浏览', async () => {
    const backend = await createBackend()

    const byTag = backend.search({ keywords: '  ', tag: 'search', category: null, limit: 10 })
    expect(byTag.map(hit => hit.path).sort()).toEqual(['/posts/rust-rewrite', '/posts/vite-build'])

    const byCategory = backend.search({ keywords: '', tag: null, category: '生活', limit: 10 })
    expect(byCategory.map(hit => hit.path)).toEqual(['/posts/life'])

    // 标签与分类是交集关系
    const intersected = backend.search({ keywords: '', tag: 'search', category: '生活', limit: 10 })
    expect(intersected).toEqual([])
  })

  it('关键词 + 范围时结果被范围过滤', async () => {
    const backend = await createBackend()
    const hits = backend.search({ keywords: '构建', tag: 'life', category: null, limit: 10 })
    expect(hits).toEqual([])

    const scoped = backend.search({ keywords: '构建', tag: 'vite', category: null, limit: 10 })
    expect(scoped.map(hit => hit.path)).toEqual(['/posts/vite-build'])
  })

  it('摘要围绕命中位置截取并带省略号', async () => {
    // 关键词两侧都要超过摘要窗口（72 字符），才能验证「居中截取」而不是「取开头」
    const filler = '这是一段用来占位的正文内容'
    const longText = `${filler.repeat(12)}关键短语${filler.repeat(12)}`
    const backend = await createMiniSearchFallback({
      source: [{ path: '/posts/long', title: '长文', date: '', text: longText, tags: [], categories: [] }]
    })

    const [hit] = backend.search({ keywords: '关键短语', tag: null, category: null, limit: 1 })

    expect(hit.snippet).toContain('关键短语')
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.snippet.endsWith('…')).toBe(true)
    expect(hit.snippet.length).toBeLessThan(longText.length)

    // 关键词紧跟在开头时不该有多余的前缀省略号
    const shortBackend = await createMiniSearchFallback({
      source: [{ path: '/posts/short', title: '短文', date: '', text: '关键短语在最前面，后面还有很多内容。', tags: [], categories: [] }]
    })
    const [shortHit] = shortBackend.search({ keywords: '关键短语', tag: null, category: null, limit: 1 })
    expect(shortHit.snippet.startsWith('…')).toBe(false)
    expect(shortHit.snippet).toContain('关键短语')
  })

  it('limit 生效，且结果字段完整', async () => {
    const backend = await createBackend()
    const hits = backend.search({ keywords: 'a', tag: null, category: null, limit: 1 })
    expect(hits.length).toBeLessThanOrEqual(1)

    const [first] = backend.search({ keywords: '搜索', tag: null, category: null, limit: 10 })
    expect(Object.keys(first).sort()).toEqual(['categories', 'date', 'path', 'snippet', 'tags', 'title'])
    expect(Array.isArray(first.tags)).toBe(true)
    expect(Array.isArray(first.categories)).toBe(true)
  })

  it('语料格式非法时报错', async () => {
    await expect(
      createMiniSearchFallback({
        source: 'https://example.com/not-an-array.json',
        fetchImpl: (async () => new Response('{"nope":1}', { status: 200 })) as typeof fetch
      })
    ).rejects.toThrow(/格式无效/)
  })

  it('语料加载失败时报错', async () => {
    await expect(
      createMiniSearchFallback({
        source: 'https://example.com/missing.json',
        fetchImpl: (async () => new Response('', { status: 404, statusText: 'Not Found' })) as typeof fetch
      })
    ).rejects.toThrow(/404/)
  })
})
