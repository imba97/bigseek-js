import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createIndex, SUPPORTED_FORMAT_VERSION } from '../src/index'

/**
 * 拿**真实 wasm 产物**验 ABI。默认跳过，因为仓库里不放二进制。
 *
 * 跑法（指向一个含 `bigseek.js` / `bigseek_bg.wasm` / `search.idx` 的目录）：
 *
 * ```bash
 * BIGSEEK_WASM_DIR=/path/to/public/search pnpm test
 * ```
 *
 * 这个测试是「ABI 从两侧一起验」的 JS 侧：Rust 侧对应的断言在 bigseek 的
 * `tests/wasm_abi.rs`（`wasm-pack test --node`）。
 */
const wasmDir = process.env.BIGSEEK_WASM_DIR
const artifactsPresent = Boolean(
  wasmDir
  && existsSync(join(wasmDir, 'bigseek.js'))
  && existsSync(join(wasmDir, 'bigseek_bg.wasm'))
  && existsSync(join(wasmDir, 'search.idx'))
)

const suite = artifactsPresent ? describe : describe.skip

suite('真实 wasm 产物的 ABI', () => {
  it('能加载并按索引格式版本校验', async () => {
    const dir = wasmDir as string
    // wasm 产物是本地文件：用自定义 fetch + loadGlue 把 file:// 映射到磁盘
    const fetchImpl = (async (input: string | URL) => {
      const name = String(input).split('/').pop() ?? ''
      return new Response(readFileSync(join(dir, name)), { status: 200 })
    }) as typeof fetch

    const index = await createIndex({
      glueUrl: pathToFileURL(join(dir, 'bigseek.js')).href,
      wasmUrl: 'file:///bigseek_bg.wasm',
      indexUrl: 'file:///search.idx',
      loadGlue: url => import(/* @vite-ignore */ url),
      fetchImpl
    })

    expect(index.formatVersion).toBe(SUPPORTED_FORMAT_VERSION)
    expect(index.docCount).toBeGreaterThan(0)
    expect(index.termCount).toBeGreaterThan(0)
    expect(index.facetCounts).toHaveLength(2)
  })

  it('格式版本不匹配时明确报错', async () => {
    const dir = wasmDir as string
    const fetchImpl = (async (input: string | URL) => {
      const name = String(input).split('/').pop() ?? ''
      return new Response(readFileSync(join(dir, name)), { status: 200 })
    }) as typeof fetch

    await expect(
      createIndex({
        glueUrl: pathToFileURL(join(dir, 'bigseek.js')).href,
        wasmUrl: 'file:///bigseek_bg.wasm',
        indexUrl: 'file:///search.idx',
        expectedFormatVersion: SUPPORTED_FORMAT_VERSION + 99,
        loadGlue: url => import(/* @vite-ignore */ url),
        fetchImpl
      })
    ).rejects.toThrow(/格式版本不匹配/)
  })

  it('raw query 的字段集合与 wasm.rs 一致', async () => {
    const dir = wasmDir as string
    const fetchImpl = (async (input: string | URL) => {
      const name = String(input).split('/').pop() ?? ''
      return new Response(readFileSync(join(dir, name)), { status: 200 })
    }) as typeof fetch

    const index = await createIndex({
      glueUrl: pathToFileURL(join(dir, 'bigseek.js')).href,
      wasmUrl: 'file:///bigseek_bg.wasm',
      indexUrl: 'file:///search.idx',
      loadGlue: url => import(/* @vite-ignore */ url),
      fetchImpl
    })

    // 空关键词 + 不限定范围会返回空数组，这里挑一个必定命中的查询
    const raw = index.raw.query('的', null, null, 1)
    expect(raw.length).toBeGreaterThan(0)
    expect(Object.keys(raw[0]).sort()).toEqual(
      ['categories', 'date', 'exact', 'path', 'score', 'snippet', 'tags', 'title']
    )

    // 对外只暴露 UI 需要的 6 个字段
    const hits = index.query({ keywords: '的', limit: 1 })
    expect(hits.length).toBeGreaterThan(0)
    expect(Object.keys(hits[0]).sort()).toEqual(
      ['categories', 'date', 'path', 'snippet', 'tags', 'title']
    )
    expect(Array.isArray(hits[0].tags)).toBe(true)
    expect(Array.isArray(hits[0].categories)).toBe(true)
  })

  it('非法索引字节流抛可捕获异常', async () => {
    const dir = wasmDir as string
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as typeof fetch

    await expect(
      createIndex({
        glueUrl: pathToFileURL(join(dir, 'bigseek.js')).href,
        wasmUrl: 'file:///bigseek_bg.wasm',
        indexUrl: 'file:///broken.idx',
        loadGlue: url => import(/* @vite-ignore */ url),
        fetchImpl
      })
    ).rejects.toThrow()
  })
})
