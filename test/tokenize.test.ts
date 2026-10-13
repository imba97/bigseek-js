import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { miniSearchTokenizer, normalizeForSearch, tokenizeForSearch } from '../src/tokenize'

interface TokenizeVector {
  name: string
  input: string
  normalized: string
  tokens: string[]
}

interface TokenizeVectorFile {
  version: number
  note: string
  cases: TokenizeVector[]
}

/**
 * 向量从 bigseek 仓库同步而来（`testdata/tokenize-vectors.json`）。
 * 需要用别的副本时设 `BIGSEEK_TOKENIZE_VECTORS` 指向文件路径。
 */
const vectorsPath = process.env.BIGSEEK_TOKENIZE_VECTORS
  ?? fileURLToPath(new URL('./vectors/tokenize-vectors.json', import.meta.url))

const file = JSON.parse(readFileSync(vectorsPath, 'utf-8')) as TokenizeVectorFile

describe(`分词向量（v${file.version}，${file.cases.length} 个用例）`, () => {
  it('向量文件本身可用', () => {
    expect(file.version).toBe(1)
    expect(file.cases.length).toBeGreaterThan(0)
  })

  for (const testCase of file.cases) {
    it(testCase.name, () => {
      // 归一化必须是逐字符 1:1，长度不变（摘要要靠它映射回原文位置）
      expect(normalizeForSearch(testCase.input)).toBe(testCase.normalized)
      expect(normalizeForSearch(testCase.input).length).toBe(testCase.input.length)

      expect(tokenizeForSearch(normalizeForSearch(testCase.input))).toEqual(testCase.tokens)
      // MiniSearch 拿到的是未归一化原文，必须得到同样结果
      expect(miniSearchTokenizer(testCase.input)).toEqual(testCase.tokens)
    })
  }
})
