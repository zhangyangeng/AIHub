import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

// Aihub 外壳 webview 前端构建配置。
// 关键点：
// 1. base './' —— 外壳通过 WebviewUrl::App("index.html") 从打包目录读静态文件，
//    资源必须是相对路径，否则 file:// 环境下加载不到。
// 2. dev server 固定端口 + strictPort，避免和 Tauri 抢端口。
export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
