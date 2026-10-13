/**
 * 站内搜索的归一化与分词 —— **必须与 bigseek 的 Rust 实现逐字对齐**。
 *
 * 为什么 JS 侧要再实现一遍：wasm 索引是主引擎，但它是可降级的（加载失败 / 未发布时回退 MiniSearch）。
 * 回退路径若用 MiniSearch 的默认分词器，中文文档级召回只有 39.7%，等于「降级即残废」。
 * 所以两条路径共用同一套分词语义，由 bigseek 仓库的 `testdata/tokenize-vectors.json`
 * 作为跨语言契约守住一致性（包内测试与博客构建期都会拿它跑一遍）。
 *
 * 对齐要点：
 * 1. 归一化是**逐字符 1:1 替换**（全角 ASCII → 半角、`U+3000` → 空格、ASCII 大写 → 小写），
 *    不增删字符 —— 这是摘要能把命中位置映射回原文的前提。
 * 2. CJK / 假名 / 谚文走 bigram，单字片段退化为 unigram。
 * 3. 拉丁与数字按 `\p{L}\p{N}` 切分，`vue3` 不拆。
 *
 * 已知差异（不影响中文语料，向量测试也不覆盖）：Rust 的 `char::is_alphanumeric()` 依据 Unicode
 * `Alphabetic` 属性，会包含少量组合记号；这里用 `\p{L}\p{N}`，不含这些记号。
 */

/** 与 Rust `tokenize::is_cjk_like` 完全一致的范围表 */
const CJK_RANGES: readonly [number, number][] = [
  [0x3040, 0x30FF], // 平假名 + 片假名
  [0x3400, 0x4DBF], // CJK 扩展 A
  [0x4E00, 0x9FFF], // CJK 基本区
  [0xAC00, 0xD7AF], // 谚文音节
  [0xF900, 0xFAFF], // CJK 兼容表意文字
  [0x20000, 0x2FA1F] // CJK 扩展 B~F + 兼容补充
]

const ALNUM_RE = /[\p{L}\p{N}]/u

export function isCjkLike(char: string): boolean {
  const codePoint = char.codePointAt(0)
  if (codePoint === undefined)
    return false
  return CJK_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)
}

/** 逐字符 1:1 归一化；输出与输入字符数相同 */
export function normalizeForSearch(input: string): string {
  let out = ''
  for (const char of input) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint === 0x3000)
      out += ' '
    else if (codePoint >= 0xFF01 && codePoint <= 0xFF5E)
      out += String.fromCodePoint(codePoint - 0xFEE0)
    else if (codePoint >= 0x41 && codePoint <= 0x5A)
      out += String.fromCharCode(codePoint + 32)
    else
      out += char
  }
  return out
}

/** 分词；输入应当已归一化 */
export function tokenizeForSearch(normalized: string): string[] {
  const out: string[] = []
  let run: string[] = []
  let runIsCjk = false

  const flush = () => {
    if (run.length === 0)
      return

    if (runIsCjk) {
      if (run.length === 1) {
        out.push(run[0])
      }
      else {
        for (let i = 0; i < run.length - 1; i++)
          out.push(run[i] + run[i + 1])
      }
    }
    else {
      let current = ''
      for (const char of run) {
        if (ALNUM_RE.test(char)) {
          current += char
        }
        else if (current) {
          out.push(current)
          current = ''
        }
      }
      if (current)
        out.push(current)
    }

    run = []
  }

  for (const char of normalized) {
    const cjk = isCjkLike(char)
    if (run.length > 0 && cjk !== runIsCjk)
      flush()
    runIsCjk = cjk
    run.push(char)
  }
  flush()
  return out
}

/** MiniSearch 的 `tokenize` 选项：入参是原文（未归一化） */
export function miniSearchTokenizer(text: string): string[] {
  return tokenizeForSearch(normalizeForSearch(text))
}
