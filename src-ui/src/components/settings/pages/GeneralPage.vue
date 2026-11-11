<script setup lang="ts">
// 通用页：外观 + 标签栏 + 窗口行为。
// 这里刻意不弹成功提示：开关自己就是反馈，再弹一条「已开启…」只是噪音。
import { computed } from 'vue';
import type { HotkeyConfig } from '@/api/types';
import { useAppStore } from '@/stores/app';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import { IS_MAC } from '@/utils/env';
import SettingRow from '@/components/settings/SettingRow.vue';
import SwitchBox from '@/components/settings/SwitchBox.vue';
import SegBox from '@/components/settings/SegBox.vue';

const appStore = useAppStore();
const { toast } = useToast();

const THEMES = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

const theme = computed(() => appStore.theme || 'system');
const hotkey = computed(() => appStore.hotkey || {});

async function setTheme(value: string) {
  const res = await api.setTheme(value);
  if (!res || !res.ok) return toast('设置失败', true);
  appStore.apply({ ...appStore.$state, theme: res.theme || value });
}

async function setTabBar(on: boolean) {
  const res = await api.setTabBar(on);
  if (!res || !res.ok) return toast('设置失败', true);
  appStore.apply({ ...appStore.$state, tabBarVisible: Boolean(res.tabBarVisible) });
}

async function setAlwaysOnTop(on: boolean) {
  const res = await api.setAlwaysOnTop(on);
  if (!res || !res.ok) return toast('设置失败', true);
  appStore.apply({ ...appStore.$state, alwaysOnTop: Boolean(res.alwaysOnTop) });
}

async function setDevtools(on: boolean) {
  const res = await api.setDevtools(on);
  if (!res || !res.ok) return toast('设置失败', true);
  appStore.apply({ ...appStore.$state, devtools: Boolean(res.devtools) });
}

async function setHotkey(patch: Partial<HotkeyConfig>) {
  const res = await api.setHotkey(patch);
  if (!res || !res.ok) return toast((res && res.error) || '设置失败', true);
  appStore.apply({ ...appStore.$state, hotkey: res.hotkey || appStore.hotkey });
}
</script>

<template>
  <div class="st-page">
    <div class="st-page-bar">
      <div>
        <h2>通用</h2>
        <p class="st-sub">外观和窗口行为</p>
      </div>
    </div>

    <div class="st-group">
      <div class="st-group-title">外观</div>
      <SettingRow title="主题" desc="不影响站点页面自身的配色。">
        <SegBox :model-value="theme" :options="THEMES" label="主题" @update:model-value="setTheme" />
      </SettingRow>
    </div>

    <div class="st-group">
      <div class="st-group-title">标签栏</div>
      <SettingRow title="显示标签栏" desc="收起后站点页面铺满窗口，恢复入口在托盘菜单里。">
        <SwitchBox
          :model-value="appStore.tabBarVisible !== false"
          label="显示标签栏"
          @update:model-value="setTabBar"
        />
      </SettingRow>
    </div>

    <div class="st-group">
      <div class="st-group-title">分屏</div>
      <div class="st-note">
        <p><b>按住标签</b>拖到页面区域，落在格子里就分成多栏；拖到已有内容的格子即互换。</p>
        <p><b>右键点标签</b>加入或移出分屏。</p>
        <p>拖动<b>栏间分隔条</b>调宽度，<b>双击</b>均分；最多四栏。</p>
      </div>
    </div>

    <div class="st-group">
      <div class="st-group-title">窗口</div>
      <SettingRow title="窗口常驻置顶" desc="始终显示在其它程序之上。">
        <SwitchBox
          :model-value="appStore.alwaysOnTop !== false"
          label="窗口常驻置顶"
          @update:model-value="setAlwaysOnTop"
        />
      </SettingRow>
      <SettingRow title="开发者工具" desc="开启后，在「站点」页每个服务的操作菜单里可打开控制台排查报错。">
        <SwitchBox
          :model-value="appStore.devtools === true"
          label="开发者工具"
          @update:model-value="setDevtools"
        />
      </SettingRow>
      <SettingRow title="显示托盘图标" desc="关掉之后窗口收进后台就没有点回来的入口了。">
        <SwitchBox
          :model-value="hotkey.tray !== false"
          label="显示托盘图标"
          @update:model-value="(v) => setHotkey({ tray: v })"
        />
      </SettingRow>
      <SettingRow title="关闭窗口时收进后台" desc="关闭按钮不退出应用，方便随时用快捷键唤回。真正退出请用托盘菜单。">
        <SwitchBox
          :model-value="hotkey.closeToTray !== false"
          label="关闭窗口时收进后台"
          @update:model-value="(v) => setHotkey({ closeToTray: v })"
        />
      </SettingRow>
      <!-- 只有 macOS 有这个概念：窗口隐藏之后 Dock 图标仍会留着。
           Windows 上 hide() 之后任务栏项本来就消失，不需要这个开关。 -->
      <SettingRow
        v-if="IS_MAC"
        title="收进后台时隐藏 Dock 图标"
        desc="收起后只在菜单栏留图标，不再占用 Dock。唤出时会自动放回，⌘Tab 和编辑快捷键不受影响。"
      >
        <SwitchBox
          :model-value="hotkey.hideDockIcon !== false"
          label="收进后台时隐藏 Dock 图标"
          @update:model-value="(v) => setHotkey({ hideDockIcon: v })"
        />
      </SettingRow>
    </div>
  </div>
</template>
