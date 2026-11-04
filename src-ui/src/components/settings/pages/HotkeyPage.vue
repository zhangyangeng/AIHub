<script setup lang="ts">
// 快捷键页：唤出键录制、常用预设、唤出时是否置顶。
import { computed, onUnmounted, ref, watch } from 'vue';
import type { HotkeyConfig } from '@/api/types';
import { useAppStore } from '@/stores/app';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import { IS_MAC, prettyAccel, acceleratorFromEvent, keyNameFromEvent } from '@/utils/env';
import SettingRow from '@/components/settings/SettingRow.vue';
import SwitchBox from '@/components/settings/SwitchBox.vue';

const appStore = useAppStore();
const { toast } = useToast();

const hk = computed(() => appStore.hotkey || {});
const enabled = computed(() => hk.value.enabled !== false);
const acc = computed(() => hk.value.accelerator || 'Alt+Space');
const presets = computed(() => hk.value.presets || []);

const recording = ref(false);

const keys = computed(() => prettyAccel(acc.value).split('+').filter(Boolean));

const MODIFIER_HINT = IS_MAC ? '⌘ / ⌥ / ⇧' : 'Ctrl / Alt / Shift';

const hintText = computed(() => {
  if (recording.value) return '按下要用的组合键，Esc 取消。建议带上 ' + MODIFIER_HINT + '。';
  if (!enabled.value) return '已关闭：只能用任务栏或托盘唤出窗口。';
  if (hk.value.registered) {
    return '已生效：在任何程序里按 ' + prettyAccel(acc.value) + ' 都能唤出窗口'
      + (hk.value.pinTop !== false ? '（带置顶）' : '') + '。';
  }
  return '没有注册成功：' + (hk.value.error || '这个组合键可能被其它程序占用了') + '。换一个试试。';
});

const hintKind = computed(() => {
  if (recording.value || !enabled.value) return '';
  return hk.value.registered ? 'ok' : 'warn';
});

async function applyHotkey(patch: Partial<HotkeyConfig>): Promise<boolean> {
  const res = await api.setHotkey(patch);
  if (!res || !res.ok) {
    toast((res && res.error) || '快捷键设置失败', true);
    return false;
  }
  appStore.apply({ ...appStore.$state, hotkey: res.hotkey || appStore.hotkey });
  return true;
}

async function toggleEnabled(on: boolean) {
  const ok = await applyHotkey({ enabled: on });
  if (!ok) return;
  if (on && !(appStore.hotkey && appStore.hotkey.registered)) {
    toast((appStore.hotkey && appStore.hotkey.error) || '快捷键注册失败，换一个组合键', true);
  }
}

async function applyPreset(item: { accelerator: string }) {
  if (item.accelerator === acc.value) return;
  const ok = await applyHotkey({ accelerator: item.accelerator });
  if (!ok) return;
  if (!(appStore.hotkey && appStore.hotkey.registered)) {
    toast((appStore.hotkey && appStore.hotkey.error) || '这个组合键被占用了，换一个试试', true);
  }
}

async function reset() {
  const fallback = (appStore.hotkey && appStore.hotkey.defaultAccelerator) || 'Alt+Space';
  const ok = await applyHotkey({ accelerator: fallback });
  if (!ok) return;
  if (!(appStore.hotkey && appStore.hotkey.registered)) {
    toast('已恢复默认，但它被其它程序占用了，请换一个', true);
  }
}

/** 录制期间在 document 上抓按键，不依赖元素焦点（点一下就走神也不会漏键） */
function onKeydown(event: KeyboardEvent) {
  if (!recording.value) return;
  event.preventDefault();
  event.stopPropagation();

  const key = keyNameFromEvent(event);
  const hasMod = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey;
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);

  if (key === 'Escape' && !hasMod) {
    recording.value = false;
    return;
  }
  if (!key || (!hasMod && !isFunctionKey)) return;

  const accelerator = acceleratorFromEvent(event);
  if (!accelerator) return;

  recording.value = false;
  applyHotkey({ accelerator }).then((ok) => {
    if (!ok) return;
    if (!(appStore.hotkey && appStore.hotkey.registered)) {
      toast((appStore.hotkey && appStore.hotkey.error) || '这个组合键被占用了，换一个试试', true);
    }
  });
}

watch(
  recording,
  (on) => {
    if (on) document.addEventListener('keydown', onKeydown, true);
    else document.removeEventListener('keydown', onKeydown, true);
  },
  { immediate: true },
);

onUnmounted(() => document.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <div class="st-page">
    <div class="st-page-bar">
      <div>
        <h2>快捷键</h2>
        <p class="st-sub">在任何程序里唤出这个窗口</p>
      </div>
    </div>

    <div class="st-group">
      <SettingRow title="启用全局快捷键" desc="按下唤出窗口，再按一次收起。">
        <SwitchBox :model-value="enabled" label="启用全局快捷键" @update:model-value="toggleEnabled" />
      </SettingRow>

      <SettingRow title="唤出按键" desc="点一下这块区域，再按下要用的组合键。">
        <button
          class="st-rec"
          type="button"
          :class="{ recording }"
          :aria-label="'当前唤出按键 ' + prettyAccel(acc) + '，点击后重新录制'"
          @click="recording = !recording"
        >
          <template v-if="recording">
            <span class="st-rec-hint">请按下组合键…</span>
          </template>
          <template v-else>
            <kbd v-for="(k, i) in keys" :key="i">{{ k }}</kbd>
          </template>
        </button>
        <button class="btn ghost" type="button" @click="reset">恢复默认</button>
      </SettingRow>

      <div class="st-presets">
        <span class="st-presets-label">常用</span>
        <button
          v-for="item in presets"
          :key="item.accelerator"
          type="button"
          :class="{ on: item.accelerator === acc }"
          :title="item.note || ''"
          @click="applyPreset(item)"
        >
          {{ item.label || prettyAccel(item.accelerator) }}
        </button>
      </div>

      <SettingRow title="唤出时强制置顶" desc="唤出后压在其它窗口之上，切走就自动取消。">
        <SwitchBox
          :model-value="hk.pinTop !== false"
          label="唤出时强制置顶"
          @update:model-value="(v) => applyHotkey({ pinTop: v })"
        />
      </SettingRow>
    </div>

    <div class="st-status" :class="hintKind">{{ hintText }}</div>
  </div>
</template>
