<script setup lang="ts">
// 设置面板，对应原 index.html 的 setOverlay / renderServiceList / 偏好设置 / 更新逻辑。
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useAppStore } from '@/stores/app';
import { useOverlayStore } from '@/stores/overlay';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import { IS_MAC, escapeHtml } from '@/utils/env';
import ServiceRow from '@/components/ServiceRow.vue';
import HotkeySection from '@/components/HotkeySection.vue';
import MigrateSection from '@/components/MigrateSection.vue';

const appStore = useAppStore();
const overlayStore = useOverlayStore();
const { toast } = useToast();

const open = computed(() => overlayStore.settingsOpen);
const visible = ref(false);
const closing = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | null = null;

// 删除确认中的服务 id 集合
const confirming = ref<Set<string>>(new Set());

const addName = ref('');
const addUrl = ref('');
const addUrlEl = ref<HTMLInputElement | null>(null);

// ---- 面板开关过渡 ----
watch(
  open,
  async (now) => {
    if (now) {
      clearTimeout(closeTimer!);
      closing.value = false;
      visible.value = true;
      confirming.value = new Set();
      await nextTick();
      // 面板可见后才知道按钮多宽，这时候再摆滑块（首次定位不要滑一段）
      return;
    }
    closing.value = true;
    clearTimeout(closeTimer!);
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    closeTimer = setTimeout(() => {
      visible.value = false;
      closing.value = false;
    }, reduced ? 190 : 150);
  },
);

// ---- 服务列表 ----
const services = computed(() => appStore.services);

function toggleConfirm(id: string) {
  const next = new Set(confirming.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  confirming.value = next;
}

function onRemoved(state: unknown) {
  if (state) appStore.apply(state as never);
}

// ---- 添加服务 ----
async function addService() {
  const name = addName.value;
  const url = addUrl.value;
  const res = await api.addService({ name, url });
  if (!res || !res.ok) return toast((res && res.error) || '添加失败', true);
  addName.value = '';
  addUrl.value = '';
  toast('已添加「' + name.trim() + '」');
  if (res.id) api.activate(res.id);
}

// ---- 偏好设置 ----
async function togglePreload(event: Event) {
  const on = (event.target as HTMLInputElement).checked;
  const res = await api.setPreload(on);
  if (!res || !res.ok) return toast('设置失败', true);
  appStore.apply({ ...appStore.$state, preload: Boolean(res.preload) });
  toast(on ? '已开启预加载：启动时把所有标签的页面都加载一遍' : '已关闭预加载：只加载标签栏当前要显示的那几栏');
}

async function toggleOnTop(event: Event) {
  const on = (event.target as HTMLInputElement).checked;
  const res = await api.setAlwaysOnTop(on);
  if (!res || !res.ok) return toast('设置失败', true);
  appStore.apply({ ...appStore.$state, alwaysOnTop: Boolean(res.alwaysOnTop) });
  toast(on ? '已开启常驻置顶：窗口会一直压在其它程序上面' : '已关闭常驻置顶');
}

async function toggleTabBar(event: Event) {
  const visibleVal = (event.target as HTMLInputElement).checked;
  const res = await api.setTabBar(visibleVal);
  if (!res || !res.ok) return toast('设置失败', true);
  appStore.apply({ ...appStore.$state, tabBarVisible: Boolean(res.tabBarVisible) });
  toast(
    visibleVal
      ? '标签栏已显示'
      : '标签栏已收起：' + (IS_MAC ? '点菜单栏里的' : '右键托盘里的') + ' Aihub 图标 →「显示 / 隐藏标签栏」可以放回来',
  );
}

// ---- 主题 ----
const THEME_LABEL: Record<string, string> = { dark: '深色', light: '浅色', system: '跟随系统' };
const THEMES = ['dark', 'light', 'system'];

const themeIndex = computed(() => {
  const current = appStore.theme || 'system';
  const i = THEMES.indexOf(current);
  return i >= 0 ? i : 2;
});

async function setTheme(theme: string) {
  const res = await api.setTheme(theme);
  if (!res || !res.ok) return toast('设置失败', true);
  const nextTheme = res.theme || theme;
  appStore.apply({ ...appStore.$state, theme: nextTheme });
  toast('外观已切换为「' + (THEME_LABEL[nextTheme] || nextTheme) + '」');
}

// ---- 休眠 ----
const NAP_LABEL: Record<number, string> = { 15: '闲置 15 分钟', 30: '闲置 30 分钟', 120: '闲置 2 小时' };
const NAPS = ['15', '30', '120', 'off'];

function napValue(): string {
  const nap = appStore.hibernate || {};
  return nap.enabled === false ? 'off' : String(nap.minutes || 30);
}

const napIndex = computed(() => {
  const current = napValue();
  const i = NAPS.indexOf(current);
  return i >= 0 ? i : 1;
});

async function setNap(want: string) {
  const payload = want === 'off' ? { enabled: false } : { enabled: true, minutes: Number(want) };
  const res = await api.setHibernate(payload);
  if (!res || !res.ok) return toast((res && res.error) || '设置失败', true);
  appStore.apply({ ...appStore.$state, hibernate: res.hibernate });
  toast(
    want === 'off'
      ? '已关闭后台休眠：所有打开过的标签都会一直留在内存里'
      : '后台标签' + NAP_LABEL[Number(want)] + '后自动休眠，点回去自动恢复',
  );
}

// ---- 版本与更新 ----
const version = ref('');
const updateHint = ref('');
const checking = ref(false);
const hasUpdate = ref(false);
const updating = ref(false);

function loadVersion() {
  api.getVersion().then((v) => (version.value = String(v))).catch(() => {});
}

async function checkUpdate() {
  checking.value = true;
  updateHint.value = '正在检查…';
  try {
    const info = await api.checkUpdate();
    if (info.error) {
      updateHint.value = '检查失败：' + info.error;
    } else if (info.available) {
      updateHint.value = '发现新版本 v' + info.version + (info.notes ? '：' + info.notes : '');
      hasUpdate.value = true;
    } else {
      updateHint.value = '已是最新版本（v' + info.current + '）';
      hasUpdate.value = false;
    }
  } catch (err) {
    updateHint.value = '检查失败：' + err;
  } finally {
    checking.value = false;
  }
}

async function forceUpdate() {
  updating.value = true;
  updateHint.value = '正在下载…';
  try {
    await api.installUpdate();
  } catch (err) {
    updateHint.value = '更新失败：' + err;
    updating.value = false;
  }
}

function onUpdateProgress(p: { phase?: string } | null | undefined) {
  if (!p) return;
  if (p.phase === 'downloading') updateHint.value = '正在下载新版本…';
  if (p.phase === 'closing') updateHint.value = '正在关闭所有页面，准备安装…';
}

// 订阅更新进度 + 版本
watch(
  visible,
  (v) => {
    if (v && !version.value) loadVersion();
  },
);

let unlistenProgress: (() => void) | null = null;
onMounted(() => {
  unlistenProgress = api.onUpdateProgress((p) => onUpdateProgress(p));
});
onUnmounted(() => {
  if (unlistenProgress) unlistenProgress();
});

const footerText = computed(() => {
  const dataDir = appStore.userData || '%APPDATA%\\Aihub';
  return 'Aihub v' + escapeHtml(version.value || appStore.version || '0.1.0') +
    ' · 每个服务的登录态独立保存在本机，不会上传到任何服务器。<br>' +
    '数据目录：<code>' + escapeHtml(dataDir) + '</code>（卸载后不会被删除）。';
});
</script>

<template>
  <div v-if="visible" id="overlay" :class="{ open, closing }">
    <section class="panel" role="dialog" aria-modal="true" aria-label="设置">
      <header>
        <img class="brand-mark sm" src="/build/icon.png" alt="" width="28" height="28" />
        <h2>设置 · 服务管理</h2>
        <button class="icon-btn" id="btn-close" title="关闭（Esc）" @click="overlayStore.setSettings(false)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>
      <div class="body">
        <p class="hint">填名字 + 网址即可新增一个标签，无需改代码或重新打包。每个服务的登录态独立保存在本地。</p>
        <div class="add-form">
          <input v-model="addName" type="text" id="add-name" placeholder="名称，如 Kimi" maxlength="40" @keydown.enter="addUrlEl && addUrlEl.focus()" />
          <input v-model="addUrl" type="url" id="add-url" ref="addUrlEl" placeholder="网址，如 https://kimi.moonshot.cn" @keydown.enter="addService" />
          <button class="btn primary" id="btn-add-confirm" @click="addService">添加</button>
        </div>
        <div class="svc-list" id="svc-list" :class="{ enter: visible }">
          <ServiceRow
            v-for="(svc, index) in services"
            :key="svc.id"
            :svc="svc"
            :index="index"
            :confirming="confirming.has(svc.id)"
            @toggle-confirm="toggleConfirm"
            @removed="onRemoved"
          />
        </div>

        <div class="pref">
          <div class="pref-row block">
            <span>
              <strong>外观主题</strong>
              <em>深色 / 浅色，或者跟随 Windows 的深浅色设置。只影响本应用自己的标签栏和设置面板。</em>
            </span>
            <div class="seg" id="theme-seg" role="radiogroup" aria-label="外观主题">
              <span class="seg-thumb" id="theme-thumb" aria-hidden="true" :style="{ transform: 'translateX(' + themeIndex * 100 + '%)' }"></span>
              <button
                v-for="(t, i) in THEMES"
                :key="t"
                class="seg-btn"
                type="button"
                role="radio"
                :data-theme="t"
                :aria-checked="themeIndex === i ? 'true' : 'false'"
                @click="setTheme(t)"
              >
                {{ THEME_LABEL[t] }}
              </button>
            </div>
          </div>
        </div>

        <div class="pref">
          <HotkeySection />
        </div>

        <div class="pref">
          <div class="pref-row block">
            <span>
              <strong>后台标签自动休眠</strong>
              <em>
                闲置超过设定时间的后台标签会释放掉它的页面进程（相当于省下一个浏览器标签的内存），
                点回去自动从原来的位置恢复。分屏里正显示的、正在出声的、正在加载的、
                输入框里有没发出去内容的标签都不会被休眠。
              </em>
            </span>
            <div class="seg" id="nap-seg" data-count="4" role="radiogroup" aria-label="后台标签自动休眠">
              <span class="seg-thumb" id="nap-thumb" aria-hidden="true" :style="{ transform: 'translateX(' + napIndex * 100 + '%)' }"></span>
              <button
                v-for="(n, i) in NAPS"
                :key="n"
                class="seg-btn"
                type="button"
                role="radio"
                :data-minutes="n"
                :aria-checked="napIndex === i ? 'true' : 'false'"
                @click="setNap(n)"
              >
                {{ n === 'off' ? '不休眠' : (n === '120' ? '2 小时' : Number(n) + ' 分钟') }}
              </button>
            </div>
          </div>
        </div>

        <div class="pref">
          <label class="pref-row">
            <input type="checkbox" id="pref-ontop" :checked="appStore.alwaysOnTop !== false" @change="toggleOnTop" />
            <span>
              <strong>窗口常驻置顶</strong>
              <em>
                让窗口一直压在其它程序上面（系统级置顶，不是应用内的层级），
                换到别的程序也不会被盖住。默认开启。这跟上面「唤出时强制置顶」不是一回事：
                那个只在按快捷键唤出的那一下生效，失焦就自动取消。
              </em>
            </span>
          </label>
        </div>

        <div class="pref">
          <label class="pref-row">
            <input type="checkbox" id="pref-tabbar" :checked="appStore.tabBarVisible !== false" @change="toggleTabBar" />
            <span>
              <strong>显示标签栏</strong>
              <em>
                关掉之后顶部这一条会收起来，站点页面铺满整个窗口，能多出 44px 的高度。
                要放回来：点菜单栏 / 托盘里的 Aihub 图标 →「显示 / 隐藏标签栏」。
              </em>
            </span>
          </label>
        </div>

        <div class="pref">
          <div class="pref-row block">
            <span>
              <strong>版本与更新</strong>
              <em id="ver-line">当前版本：{{ version || '读取中…' }}</em>
            </span>
            <div class="hk-row">
              <button class="btn ghost" id="btn-check-update" type="button" :disabled="checking" @click="checkUpdate">检查更新</button>
              <button class="btn primary" id="btn-force-update" type="button" :hidden="!hasUpdate" :disabled="updating" @click="forceUpdate">强制更新并重启</button>
            </div>
            <div class="hk-hint" id="update-hint">{{ updateHint }}</div>
          </div>
        </div>

        <div class="pref">
          <label class="pref-row">
            <input type="checkbox" id="pref-preload" :checked="appStore.preload !== false" @change="togglePreload" />
            <span>
              <strong>启动时预加载所有标签</strong>
              <em>
                默认关闭，启动时只加载标签栏当前要显示的那几栏。开启后会把所有标签的页面都真实加载一遍，
                标签栏上就能看到各站点自己的标题——logo 不开这个也有。代价是启动即多个渲染进程和多次真实请求。
              </em>
            </span>
          </label>
        </div>

        <MigrateSection />
      </div>
      <footer id="panel-footer" v-html="footerText"></footer>
    </section>
  </div>
</template>

<script lang="ts">
export default { name: 'SettingsPanel' };
</script>
