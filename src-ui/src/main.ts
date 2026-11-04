import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/variables.scss';
import './styles/base.scss';
import './styles/settings.scss';
import { installTabDragGlobals } from '@/composables/useTabDrag';
import { installDividerCleanup } from '@/composables/useDividerDrag';

// 拖拽 / 分隔条的回调挂在 document 上，必须在挂载前装好，
// 否则第一帧的拖拽手势收不到事件。
installTabDragGlobals();
installDividerCleanup();

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
