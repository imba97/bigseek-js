import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: [
    'src/index'
  ],
  clean: true,
  declaration: true,
  rollup: {
    esbuild: {
      minify: true
    },
    // 不内联依赖：minisearch 只在回退入口里被**动态** import，
    // 打包进来会让所有消费者都多背一份（也让 Vite 无法把它拆成按需 chunk）
    inlineDependencies: false,
    dts: {
      respectExternal: false
    }
  }
})
