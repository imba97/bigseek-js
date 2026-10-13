import { antfu } from '@antfu/eslint-config'

export default antfu({
  ignores: [
    // 从 bigseek 同步来的跨语言契约向量：里面的全角空格 / 全角标点是测试数据本身
    'test/vectors/**'
  ],
  rules: {
    'style/comma-dangle': ['warn', 'never']
  }
})
