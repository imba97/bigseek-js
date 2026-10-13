import type { WasmSearchHit } from '../types'

/**
 * wasm-bindgen `--target web` 生成的 glue 模块形状。
 *
 * 这些名字**必须与 bigseek 的 `src/wasm.rs` 里 `#[wasm_bindgen]` 导出的一致**
 * （`new` / `docCount` / `termCount` / `formatVersion` / `facetCounts` / `query`）；
 * 改 ABI 时两边一起改，并由 `test/wasm-abi.test.ts`（opt-in）拿真实产物校验。
 */
export interface WasmSearchModule {
  /** `--target web` 的初始化函数；显式传字节可绕开 MIME 与路径问题 */
  default: (input: { module_or_path: BufferSource }) => Promise<unknown>
  SearchIndex: new (bytes: Uint8Array) => WasmSearchIndex
}

export interface WasmSearchIndex {
  /** tag / category 传 null 或省略表示不限定范围；limit 传 null 用默认值 40 */
  query: (
    keywords: string,
    tag?: string | null,
    category?: string | null,
    limit?: number | null
  ) => WasmSearchHit[]
  docCount: () => number
  termCount: () => number
  formatVersion: () => number
  /** `[标签数, 分类数]` */
  facetCounts: () => number[]
}
