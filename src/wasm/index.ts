import type { SearchHit, SearchQuery, WasmSearchHit } from '../types'
import type { WasmSearchIndex, WasmSearchModule } from './glue'
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SUPPORTED_FORMAT_VERSION } from '../types'

export interface CreateIndexOptions {
  /** wasm-bindgen glue（`bigseek.js`）地址 */
  glueUrl: string
  /** wasm 二进制（`bigseek_bg.wasm`）地址 */
  wasmUrl: string
  /** 索引文件（`search.idx`）地址 */
  indexUrl: string
  /**
   * 期望的索引格式版本。不匹配直接抛错，而不是静默返回空结果——
   * 这是防止「crate 升了、客户端没升」这类漂移的唯一运行时防线。
   */
  expectedFormatVersion?: number
  /** 自定义 glue 加载（测试、或把 glue 打进 bundle 时用） */
  loadGlue?: (url: string) => Promise<WasmSearchModule>
  fetchImpl?: typeof fetch
}

/** 一个可直接查询的 wasm 索引 */
export interface BigseekIndex {
  readonly docCount: number
  readonly termCount: number
  readonly formatVersion: number
  /** `[标签数, 分类数]` */
  readonly facetCounts: number[]
  query: (query: SearchQuery) => SearchHit[]
  /** 底层 wasm 索引句柄（逃生口，一般不需要） */
  readonly raw: WasmSearchIndex
}

function clampLimit(limit?: number): number {
  if (limit === undefined || limit === null || Number.isNaN(limit))
    return SEARCH_LIMIT_DEFAULT
  return Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(limit)))
}

/** 运行时动态 import glue；`@vite-ignore` 阻止打包器分析这个运行时拼出的 URL */
async function defaultLoadGlue(url: string): Promise<WasmSearchModule> {
  return (await import(/* @vite-ignore */ url)) as WasmSearchModule
}

async function fetchBytes(
  url: string,
  label: string,
  fetchImpl: typeof fetch
): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetchImpl(url)
  if (!res.ok)
    throw new Error(`加载${label}失败：${res.status} ${res.statusText}（${url}）`)
  // 显式标注成 Uint8Array<ArrayBuffer>：BufferSource 不接受可能来自 SharedArrayBuffer 的视图
  return new Uint8Array(await res.arrayBuffer())
}

export function toSearchHit(hit: WasmSearchHit): SearchHit {
  return {
    path: hit.path,
    title: hit.title,
    date: hit.date,
    snippet: hit.snippet,
    // wasm 侧返回的是跨边界视图，复制成普通数组避免持有引用
    tags: [...hit.tags],
    categories: [...hit.categories]
  }
}

export async function createIndex(options: CreateIndexOptions): Promise<BigseekIndex> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (typeof fetchImpl !== 'function')
    throw new Error('当前环境没有 fetch，可通过 fetchImpl 传入一个实现')

  const loadGlue = options.loadGlue ?? defaultLoadGlue

  const [glue, wasmBytes, indexBytes] = await Promise.all([
    loadGlue(options.glueUrl),
    fetchBytes(options.wasmUrl, 'wasm 模块', fetchImpl),
    fetchBytes(options.indexUrl, '搜索索引', fetchImpl)
  ])

  if (typeof glue?.default !== 'function' || typeof glue?.SearchIndex !== 'function')
    throw new Error('wasm glue 模块形状异常（缺少 default / SearchIndex）')

  await glue.default({ module_or_path: wasmBytes })
  const raw = new glue.SearchIndex(indexBytes)

  const formatVersion = raw.formatVersion()
  const expected = options.expectedFormatVersion ?? SUPPORTED_FORMAT_VERSION
  if (formatVersion !== expected) {
    throw new Error(
      `索引格式版本不匹配：索引是 v${formatVersion}，本库支持 v${expected}。`
      + ' 请让 bigseek 的 crate 与 bigseek-js 的版本对齐后重新生成索引。'
    )
  }

  return {
    docCount: raw.docCount(),
    termCount: raw.termCount(),
    formatVersion,
    facetCounts: [...raw.facetCounts()],
    query: (query) => {
      const hits = raw.query(
        query.keywords,
        query.tag ?? null,
        query.category ?? null,
        clampLimit(query.limit)
      )
      return hits.map(toSearchHit)
    },
    raw
  }
}
