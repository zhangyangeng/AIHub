<script setup lang="ts">
// 通用页：外观 + 标签栏 + 窗口行为。
// 这里刻意不弹成功提示：开关自己就是反馈，再弹一条「已开启…」只是噪音。
import { computed } from 'vue';
import type { HotkeyConfig } from '@/api/types';
import { useAppStore } from '@/stores/app';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
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
      <div class="st-group-title">窗口</div>
      <SettingRow title="窗口常驻置顶" desc="始终显示在其它程序之上。">
        <SwitchBox
          :model-value="appStore.alwaysOnTop !== false"
          label="窗口常驻置顶"
          @update:model-value="setAlwaysOnTop"
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
    </div>
  </div>
</template>
