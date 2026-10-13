import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 构建产物断言：仓库里的测试全部从 `src/` 引入，跑绿并不能说明**发布出去的那份**是对的。
 * 这里直接读 `dist/`（`pnpm run build` 之后才有，未构建时整组跳过）。
 */
const distMjs = fileURLToPath(new URL('../dist/index.mjs', import.meta.url))
const distDts = fileURLToPath(new URL('../dist/index.d.ts', import.meta.url))
const built = existsSync(distMjs) && existsSync(distDts)

describe.runIf(built)('构建产物（dist）', () => {
  const code = built ? readFileSync(distMjs, 'utf-8') : ''
  const types = built ? readFileSync(distDts, 'utf-8') : ''

  it('minisearch 保持动态 import（没有被内联进主 chunk）', () => {
    expect(code).toMatch(/import\(\s*["']minisearch["']\s*\)/)
  })

  it('公开 API 都在导出面里', () => {
    for (const name of [
      'createIndex',
      'createSearchClient',
      'serveSearch',
      'createMiniSearchFallback',
      'miniSearchTokenizer',
      'normalizeForSearch',
      'resolveLimit',
      'PROTOCOL_VERSION',
      'SUPPORTED_FORMAT_VERSION'
    ]) {
      expect(code, `缺少导出：${name}`).toMatch(new RegExp(`\\b${name}\\b`))
    }
  })

  it('类型声明包含关键类型', () => {
    for (const name of ['BigseekIndex', 'SearchClient', 'SearchHit', 'ServeSearchOptions'])
      expect(types, `缺少类型：${name}`).toContain(name)
  })
})
