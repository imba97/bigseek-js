import type { BackendQuery, SearchBackend } from '../backend'
import type { SearchHit } from '../types'
import { miniSearchTokenizer } from '../tokenize'
import { SEARCH_LIMIT_DEFAULT } from '../types'

/** 回退语料的一条记录（就是博客构建期产出的 `search-full.json` 的元素） */
export interface MiniSearchRecord {
  path: string
  title: string
  date: string
  text: string
  tags: string[]
  categories: string[]
}

export interface MiniSearchFallbackOptions {
  /** 语料来源：URL（fetch JSON）或直接给数组 */
  source: string | URL | MiniSearchRecord[]
  fetchImpl?: typeof fetch
  /** 自定义分词；默认用与 wasm 侧逐字对齐的 CJK bigram 分词器 */
  tokenize?: (text: string) => string[]
  /** 传给 MiniSearch 的 searchOptions */
  searchOptions?: Record<string, unknown>
  /** 摘要取命中位置前后各多少字符 */
  snippetWindow?: number
  /** 摘要最大长度 */
  snippetMaxLength?: number
}

interface MiniSearchLike {
  addAll: (docs: Record<string, unknown>[]) => void
  search: (query: string, options?: Record<string, unknown>) => Array<Record<string, unknown>>
}

interface SearchCorpus {
  mini: MiniSearchLike
  docsByPath: Map<string, MiniSearchRecord>
  tagPathIndex: Map<string, Set<string>>
  categoryPathIndex: Map<string, Set<string>>
}

const SNIPPET_WINDOW_SIZE = 72
const SNIPPET_MAX_LENGTH = 140

const SEARCH_OPTIONS = {
  combineWith: 'AND' as const,
  prefix: true,
  fuzzy: 0.12
}

const INDEX_SEARCH_OPTIONS = {
  boost: { title: 4, tagLine: 3, catLine: 2, body: 1 },
  fuzzy: 0.12,
  prefix: true
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  return value.filter((item): item is string => typeof item === 'string')
}

function truncate(body: string, maxLength: number): string {
  return body.slice(0, maxLength) + (body.length > maxLength ? '…' : '')
}

/** 摘要围绕**第一个关键词**出现的位置截取，而不是无脑取头部 */
function buildSnippet(body: string, keywords: string, windowSize: number, maxLength: number): string {
  const query = keywords.trim().toLowerCase()
  const words = query.split(/\s+/).filter(Boolean)
  const first = words[0] ?? query
  if (!first)
    return truncate(body, maxLength)

  const idx = body.toLowerCase().indexOf(first)
  if (idx === -1)
    return truncate(body, maxLength)

  const start = Math.max(0, idx - windowSize)
  const end = Math.min(body.length, idx + query.length + windowSize)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

function hitsFromRecords(records: MiniSearchRecord[], limit: number): SearchHit[] {
  return records.slice(0, limit).map(record => ({
    path: record.path,
    title: record.title,
    date: record.date,
    snippet: '',
    tags: [...record.tags],
    categories: [...record.categories]
  }))
}

function intersectPathSets(left: Set<string>, right: Set<string>): Set<string> {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  const output = new Set<string>()
  for (const path of small) {
    if (large.has(path))
      output.add(path)
  }
  return output
}

function createSearchCorpus(records: MiniSearchRecord[], MiniSearch: new (options: Record<string, unknown>) => MiniSearchLike, tokenize: (text: string) => string[]): SearchCorpus {
  const docsByPath = new Map<string, MiniSearchRecord>()
  const tagPathIndex = new Map<string, Set<string>>()
  const categoryPathIndex = new Map<string, Set<string>>()

  const mini = new MiniSearch({
    fields: ['title', 'body', 'tagLine', 'catLine'],
    storeFields: ['path', 'title', 'date', 'text', 'tags', 'categories'],
    searchOptions: INDEX_SEARCH_OPTIONS,
    tokenize
  })

  const addToIndex = (index: Map<string, Set<string>>, key: string, path: string) => {
    const paths = index.get(key)
    if (paths)
      paths.add(path)
    else
      index.set(key, new Set([path]))
  }

  mini.addAll(
    records.map((record) => {
      docsByPath.set(record.path, record)

      for (const tag of record.tags)
        addToIndex(tagPathIndex, tag, record.path)
      for (const category of record.categories)
        addToIndex(categoryPathIndex, category, record.path)

      return {
        id: record.path,
        title: record.title,
        body: record.text,
        tagLine: record.tags.join(' '),
        catLine: record.categories.join(' '),
        path: record.path,
        date: record.date,
        text: record.text,
        tags: record.tags,
        categories: record.categories
      }
    })
  )

  return { mini, docsByPath, tagPathIndex, categoryPathIndex }
}

function resolveScopePaths(corpus: SearchCorpus, tag: string | null, category: string | null): Set<string> | null {
  const tagPaths = tag ? corpus.tagPathIndex.get(tag) : null
  const categoryPaths = category ? corpus.categoryPathIndex.get(category) : null

  if (tagPaths && categoryPaths)
    return intersectPathSets(tagPaths, categoryPaths)
  return tagPaths ?? categoryPaths ?? null
}

function searchInCorpus(
  corpus: SearchCorpus,
  query: BackendQuery,
  snippetWindow: number,
  snippetMaxLength: number
): SearchHit[] {
  const keywords = query.keywords.trim()
  const scopePaths = resolveScopePaths(corpus, query.tag, query.category)
  const limit = query.limit || SEARCH_LIMIT_DEFAULT

  // 没有关键词时就是「按标签/分类浏览」
  if (!keywords) {
    if (!scopePaths)
      return []
    const subset: MiniSearchRecord[] = []
    for (const path of scopePaths) {
      const record = corpus.docsByPath.get(path)
      if (!record)
        continue
      subset.push(record)
      if (subset.length >= limit)
        break
    }
    return hitsFromRecords(subset, limit)
  }

  let results: Array<Record<string, unknown>>
  try {
    results = corpus.mini.search(keywords, SEARCH_OPTIONS)
  }
  catch {
    return []
  }

  const filtered = scopePaths
    ? results.filter(result => scopePaths.has(String(result.path ?? result.id)))
    : results

  return filtered.slice(0, limit).map((result) => {
    const text = String(result.text ?? '')
    return {
      path: String(result.path ?? result.id),
      title: String(result.title ?? ''),
      date: String(result.date ?? ''),
      tags: asStringList(result.tags),
      categories: asStringList(result.categories),
      snippet: buildSnippet(text, keywords, snippetWindow, snippetMaxLength)
    }
  })
}

async function loadRecords(options: MiniSearchFallbackOptions): Promise<MiniSearchRecord[]> {
  const { source } = options
  if (Array.isArray(source))
    return source

  // 只有要从 URL 取语料时才需要 fetch
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (typeof fetchImpl !== 'function')
    throw new Error('当前环境没有 fetch，可通过 fetchImpl 传入一个实现')

  const res = await fetchImpl(String(source))
  if (!res.ok)
    throw new Error(`加载回退语料失败：${res.status} ${res.statusText}（${String(source)}）`)

  const parsed: unknown = JSON.parse(await res.text())
  if (!Array.isArray(parsed))
    throw new Error('回退语料格式无效：期望一个数组')
  return parsed as MiniSearchRecord[]
}

/**
 * 建一个 MiniSearch 回退后端。
 *
 * 用途：wasm 索引没发布 / 加载失败 / 被显式关闭时，用构建期产出的 JSON 语料继续提供搜索。
 * `minisearch` 是**动态** import 的，不调用这个函数就不会被加载。
 */
export async function createMiniSearchFallback(options: MiniSearchFallbackOptions): Promise<SearchBackend> {
  const records = await loadRecords(options)
  const { default: MiniSearch } = await import('minisearch')

  const corpus = createSearchCorpus(
    records,
    MiniSearch as unknown as new (options: Record<string, unknown>) => MiniSearchLike,
    options.tokenize ?? miniSearchTokenizer
  )

  const snippetWindow = options.snippetWindow ?? SNIPPET_WINDOW_SIZE
  const snippetMaxLength = options.snippetMaxLength ?? SNIPPET_MAX_LENGTH

  return {
    engine: 'minisearch',
    search: query => searchInCorpus(corpus, query, snippetWindow, snippetMaxLength)
  }
}
