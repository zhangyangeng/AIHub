import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/variables.css';
import './styles/base.css';
import { installTabDragGlobals } from '@/composables/useTabDrag';
import { installDividerCleanup } from '@/composables/useDividerDrag';

// 拖拽 / 分隔条这些全局手势依赖 document 级事件监听，
// 在应用挂载前一次性装好（对应原 index.html 里散落的 document.addEventListener）。
installTabDragGlobals();
installDividerCleanup();

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
