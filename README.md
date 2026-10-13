# bigseek

[中文](./README_CN.md) · **English**

[![npm](https://img.shields.io/npm/v/bigseek.svg)](https://www.npmjs.com/package/bigseek)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/actions/workflow/status/imba97/bigseek-js/release.yaml?label=Release)](https://github.com/imba97/bigseek-js/actions/workflows/release.yaml)
[![Types](https://img.shields.io/badge/types-included-blue.svg)](#api)

Browser client for [bigseek](https://github.com/imba97/bigseek) indexes: a WebAssembly query
engine, a CJK bigram tokenizer, and an optional MiniSearch fallback.

This package only *consumes* an index. Index generation and the wasm build live in the
[bigseek](https://github.com/imba97/bigseek) repository, and the artifacts are distributed
through its [GitHub releases](https://github.com/imba97/bigseek/releases) — the client downloads
them at runtime, so the package carries no binary.

## Table of Contents

- [Background](#background)
- [Features](#features)
- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [Notes](#notes)
- [License](#license)

## Background

Whitespace-and-punctuation tokenizers treat a whole Chinese clause as one term, which drops
document-level recall to **39.7%** on a 144-post Chinese corpus; only terms that start a
sentence remain reachable. bigseek indexes CJK as bigrams and reaches **100%**.

Because the WebAssembly index is degradable (a missing or failed artifact), the fallback path
has to tokenize the same way — otherwise "degraded" silently means "crippled". That is why the
tokenizer ships with this package instead of relying on the fallback engine's default.

## Features

- **Worker-first** — `serveSearch()` hosts the engine inside a Worker, `createSearchClient()`
  drives it from the main thread. Both share one message protocol with a version handshake.
- **Latest-wins queries** — a burst of keystrokes collapses into one result set; stale responses
  are dropped instead of rendered out of order.
- **Optional MiniSearch fallback** — `createMiniSearchFallback()` answers from a documents JSON
  when the wasm artifacts are unavailable. `minisearch` is imported dynamically, so consumers
  that never use the fallback do not bundle it.
- **Format-version check** — `createIndex()` refuses an index whose format version does not match
  the library, turning "crate upgraded, client not" into an explicit error instead of empty
  results.
- **Framework-agnostic** — state is a plain snapshot object plus a `subscribe()` callback, so it
  drops into Vue, React, or plain DOM without an adapter.
- **Degradation you can see** — a timeout, a crashed Worker, and a disposed client are all
  distinguishable from "no results".

## Install

```bash
npm install bigseek
```

```bash
pnpm add bigseek
```

## Usage

### Hosting queries in a Worker (recommended)

Worker entry:

```ts
import { createMiniSearchFallback, serveSearch } from 'bigseek'

const base = import.meta.env.BASE_URL || '/'

serveSearch({
  wasm: {
    glueUrl: `${base}search/bigseek.js`,
    wasmUrl: `${base}search/bigseek_bg.wasm`,
    indexUrl: `${base}search/search.idx`
  },
  // Optional: keeps search working when the wasm artifacts are missing
  fallback: () => createMiniSearchFallback({ source: `${base}search-full.json` })
})
```

Main thread:

```ts
import { createSearchClient } from 'bigseek'

const client = createSearchClient({
  worker: () => import.meta.env.SSR
    ? null
    : new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })
})

client.subscribe((state) => {
  // state is a fresh object on every change: `ref(client.state)` works as-is
  console.log(state.ready, state.engine, state.error)
})

await client.ensureReady()
const hits = await client.search({ keywords: '性能优化', tag: 'rust', limit: 20 })
```

### Without a Worker

```ts
import { createIndex } from 'bigseek'

const index = await createIndex({
  glueUrl: '/search/bigseek.js',
  wasmUrl: '/search/bigseek_bg.wasm',
  indexUrl: '/search/search.idx'
})

index.docCount // 144
index.termCount // 24154
index.facetCounts // [tag count, category count]
index.query({ keywords: '性能', tag: null, category: null, limit: 40 })
// → [{ path, title, date, snippet, tags, categories }]

index.dispose() // release the wasm-side index when you are done with it
```

### Fallback engine only

```ts
import { createMiniSearchFallback } from 'bigseek'

const backend = await createMiniSearchFallback({ source: '/search-full.json' })
backend.search({ keywords: '性能', tag: null, category: null, limit: 20 })
```

## API

### `serveSearch(options)`

Called once inside a Worker. Loads the configured backend lazily on `preload`, or on the first
query.

| Option | Type | Description |
| --- | --- | --- |
| `wasm` | `CreateIndexOptions` | URL set for the wasm engine |
| `fallback` | `() => SearchBackend \| Promise<SearchBackend>` | Backend factory used when wasm is unavailable |
| `engine` | `'auto' \| 'wasm' \| 'minisearch'` | `auto` (default) tries wasm then falls back; the others force one path |
| `scope` | `SearchWorkerScope` | Message scope; defaults to `globalThis` |
| `log` | `(message, ...args) => void` | Log sink |

### `createSearchClient(options)`

| Option | Type | Description |
| --- | --- | --- |
| `worker` | `WorkerLike \| (() => WorkerLike \| null)` | Worker instance or factory; returning `null` (e.g. during SSR) makes every call a safe no-op |
| `preload` | `boolean` | Start loading immediately (default `false`) |
| `timeoutMs` | `number` | Per-query timeout, default `10000`; `0` disables it |
| `debug` / `log` | `boolean` / function | Log engine readiness and errors |

`SearchClient` members:

| Member | Description |
| --- | --- |
| `state` | `{ ready, error, engine, stats, disposed, failed }` snapshot |
| `ensureReady()` | Preload and resolve once ready; rejects after a fatal Worker error |
| `search(query)` | Latest-wins query; superseded calls resolve to `[]` |
| `reload()` | Discard the current engine and load again (explicit retry) |
| `subscribe(listener)` | Observe state changes; returns an unsubscribe function |
| `dispose()` | Settle pending work, detach the Worker, and make further calls no-ops |

### `createIndex(options)`

| Option | Type | Description |
| --- | --- | --- |
| `glueUrl` / `wasmUrl` / `indexUrl` | `string` | URLs of `bigseek.js`, `bigseek_bg.wasm`, and `search.idx` |
| `expectedFormatVersion` | `number` | Required index format version (defaults to the version this package supports) |
| `loadGlue` | `(url) => Promise<WasmSearchModule>` | Custom glue loader (tests, pre-bundled glue) |
| `fetchImpl` | `typeof fetch` | Custom fetch (tests, non-HTTP sources) |

Returns a `BigseekIndex`: `docCount`, `termCount`, `formatVersion`, `facetCounts`, `query()`,
`dispose()`, and `raw` (the underlying wasm handle).

### `createMiniSearchFallback(options)`

| Option | Type | Description |
| --- | --- | --- |
| `source` | `string \| URL \| MiniSearchRecord[]` | Documents JSON URL, or records directly |
| `tokenize` | `(text) => string[]` | Override the tokenizer (defaults to the shared CJK bigram tokenizer) |
| `searchOptions` | `object` | Passed through to MiniSearch |
| `snippetWindow` / `snippetMaxLength` | `number` | Snippet window sizing |

### Utilities

| Export | Description |
| --- | --- |
| `miniSearchTokenizer`, `tokenizeForSearch`, `normalizeForSearch`, `isCjkLike` | The tokenizer shared with the Rust implementation |
| `resolveLimit(limit?)` | Normalizes a limit into `[1, 200]`; used by every query path |
| `SUPPORTED_FORMAT_VERSION`, `PROTOCOL_VERSION`, `SEARCH_LIMIT_DEFAULT`, `SEARCH_LIMIT_MAX` | Constants |
| `SearchHit`, `SearchQuery`, `BigseekIndex`, `SearchClient`, … | Types (TypeScript declarations are bundled) |

## Notes

- **Query semantics.** A query is the last one issued: superseded calls resolve to `[]` rather
  than racing. `tag` / `category` accept `null` for "unscoped"; `limit` is clamped to `[1, 200]`
  on every engine, so the wasm and fallback paths cannot disagree.
- **Failure handling.** A backend that throws during a query yields an empty result for that
  request instead of leaving it pending. If engine initialization fails, it is not retried per
  query (that would re-download the corpus on every keystroke) — call `reload()` to retry
  explicitly. Queries time out after `timeoutMs`.
- **Bundlers.** `minisearch` is imported dynamically; a normal web build splits it into an
  on-demand chunk, while Vite's Worker build (IIFE with `inlineDynamicImports`) inlines it into
  the Worker bundle (~14 KiB).
- **Protocol version.** Worker and client both stamp `PROTOCOL_VERSION` on every message. A
  cached older Worker chunk therefore produces an explicit error instead of queries that never
  return.
- **Contract.** The tokenizer is tested against the same vector file as the Rust implementation,
  so both engines retrieve the same documents.

## License

[MIT](./LICENSE)
