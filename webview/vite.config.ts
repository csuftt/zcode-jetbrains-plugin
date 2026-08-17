import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// 开发模式 + 生产多文件构建配置：
// - dev (npm run dev)：跑 dev server (localhost:5173)，Java 端 JCEF 直连此地址（HMR）
// - build (npm run build)：多文件产物 + sourcemap 输出到 resources/webview/，
//   Java 端内置 HttpServer serve 此目录——生产模式也有真实 origin，DevTools 可直接
//   看 TS/TSX 源码断点（详见 docs/设计与调研/内嵌浏览器前端调试移植调研.md 方案 C）
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // Less 全局变量注入（后续阶段加 theme.less 时用）
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true, // 端口被占就直接报错，不漂移（Java 端硬编码 5173）
    host: 'localhost', // 只监听本地，不暴露到网络
  },
  build: {
    outDir: '../intellij-plugin/src/main/resources/webview',
    emptyOutDir: true,
    sourcemap: true, // 生产可调试：DevTools 直接映射回 TS/TSX 源码
    chunkSizeWarningLimit: 5000,
  },
})
