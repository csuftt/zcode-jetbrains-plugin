import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'

// 单文件 fallback 配置：打成单个 index.html 输出到 resources/webview-single/。
// 仅在内置 HttpServer 启动失败（端口全占等）时由 Java 端降级加载（loadHTML，无 origin 无 sourcemap）
export default defineConfig({
  plugins: [
    react(),
    viteSingleFile({
      // 所有 JS/CSS 内联到一个 HTML 文件
      removeViteModuleLoader: true,
      inlinePattern: ['**/*.{js,css}'],
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true,
      },
    },
  },
  build: {
    outDir: '../intellij-plugin/src/main/resources/webview-single',
    emptyOutDir: true,
    // singlefile 模式下 chunk 大小警告无意义
    chunkSizeWarningLimit: 5000,
  },
})
