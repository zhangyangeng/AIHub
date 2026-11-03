<script setup lang="ts">
// 全局快捷键（老板键）区块：显示当前组合、录制新组合、启停开关。
import { computed, ref } from 'vue';
import { useAppStore } from '@/stores/app';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import { IS_MAC, prettyAccel, keyNameFromEvent, acceleratorFromEvent } from '@/utils/env';

const appStore = useAppStore();
const { toast } = useToast();

const recording = ref(false);

const MODIFIER_HINT = IS_MAC ? '⌘ / ⌥ / ⇧' : 'Ctrl / Alt / Shift';

const hk = computed(() => appStore.hotkey || {});
const enabled = computed(() => hk.value.enabled !== false);
const acc = computed(() => hk.value.accelerator || 'Alt+Space');

const presets = computed(() => hk.value.presets || []);

// 提示语
const hintText = computed(() => {
  if (recording.value) return '按下要用的组合键（Esc 取消）；建议带 ' + MODIFIER_HINT;
  if (!enabled.value) return '已关闭：不再占用系统级快捷键，窗口只能从任务栏或托盘唤出。';
  if (hk.value.registered) {
    return '已生效：在任何程序里按 ' + prettyAccel(acc.value) + ' 都能唤出 / 收起窗口'
      + (hk.value.pinTop !== false ? '（唤出时最高优先级置顶）' : '') + '。';
  }
  return '没有注册成功：' + (hk.value.error || '这个组合键可能已被其它程序占用')
    + '。换成别的组合键，或先关掉占用它的程序。';
});

const hintKind = computed(() => {
  if (recording.value) return '';
  if (!enabled.value) return '';
  if (hk.value.registered) return 'ok';
  return 'warn';
});

function startRecording() {
  recording.value = true;
}

function stopRecording() {
  recording.value = false;
}

function finishRecording() {
  recording.value = false;
}

async function applyHotkey(patch: Partial<NonNullable<typeof hk.value>>): Promise<boolean> {
  const res = await api.setHotkey(patch);
  if (!res || !res.ok) {
    toast((res && res.error) || '快捷键设置失败', true);
    return false;
  }
  appStore.apply({ ...appStore.$state, hotkey: res.hotkey || appStore.hotkey });
  return true;
}

async function applyPreset(item: { accelerator: string }) {
  if (item.accelerator === acc.value) return;
  const ok = await applyHotkey({ accelerator: item.accelerator });
  if (!ok) return;
  const registered = (appStore.hotkey && appStore.hotkey.registered) || false;
  toast(
    registered
      ? '唤出快捷键已改为 ' + prettyAccel(appStore.hotkey.accelerator)
      : ((appStore.hotkey && appStore.hotkey.error) || prettyAccel(item.accelerator) + ' 被占用，换一个试试'),
    !registered,
  );
}

async function toggleEnabled(event: Event) {
  const on = (event.target as HTMLInputElement).checked;
  const ok = await applyHotkey({ enabled: on });
  if (!ok) return;
  const registered = (appStore.hotkey && appStore.hotkey.registered) || false;
  if (on && !registered) return toast(appStore.hotkey.error || '快捷键注册失败，请换一个组合键', true);
  toast(on ? '已启用：按 ' + prettyAccel(acc.value) + ' 唤出 / 收起窗口' : '已关闭全局快捷键');
}

async function togglePinTop(event: Event) {
  await applyHotkey({ pinTop: (event.target as HTMLInputElement).checked });
}

async function toggleTray(event: Event) {
  await applyHotkey({ tray: (event.target as HTMLInputElement).checked });
}

async function toggleClose(event: Event) {
  await applyHotkey({ closeToTray: (event.target as HTMLInputElement).checked });
}

async function reset() {
  const fallback = (appStore.hotkey && appStore.hotkey.defaultAccelerator) || 'Alt+Space';
  const ok = await applyHotkey({ accelerator: fallback });
  if (!ok) return;
  const registered = (appStore.hotkey && appStore.hotkey.registered) || false;
  toast(
    registered
      ? '已恢复默认快捷键 ' + prettyAccel(appStore.hotkey.accelerator)
      : '已恢复默认，但 ' + prettyAccel(appStore.hotkey.accelerator) + ' 被其它程序占用，请换一个',
  );
}

function onKeyDown(event: KeyboardEvent) {
  if (!recording.value) startRecording();
  event.preventDefault();
  event.stopPropagation();
  const key = keyNameFromEvent(event);
  const hasMod = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey;
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);

  if (key === 'Escape' && !hasMod) {
    finishRecording();
    return;
  }
  if (!key || (!hasMod && !isFunctionKey)) {
    if (key) {
      // 至少带一个修饰键，或者单用 F1~F24
    }
    return;
  }
  const accelerator = acceleratorFromEvent(event);
  // 立即把录到的组合键写回输入框显示
  appStore.apply({ ...appStore.$state, hotkey: { ...appStore.hotkey, accelerator } });
  applyHotkey({ accelerator }).then((ok) => {
    if (ok) {
      toast('唤出快捷键已改为 ' + prettyAccel(appStore.hotkey.accelerator));
      finishRecording();
    }
  });
}
</script>

<template>
  <div class="pref-row block">
    <span>
      <strong>全局快捷键唤出</strong>
      <em>
        系统级快捷键：不管当前前台是哪个程序（哪怕在别的程序的全屏窗口里）按下它都能把窗口唤到最前，
        优先级高于应用内快捷键；再按一次收起。注册不上会在这里写明原因。
      </em>
    </span>
    <div class="hk-row">
      <label class="hk-toggle">
        <input type="checkbox" id="hk-enabled" :checked="enabled" @change="toggleEnabled" />
        <span>启用</span>
      </label>
      <input
        type="text"
        id="hk-key"
        class="hk-key"
        readonly
        aria-label="唤出快捷键"
        :value="prettyAccel(acc)"
        :class="{ recording }"
        @focus="startRecording"
        @blur="stopRecording"
        @mousedown="startRecording"
        @keydown="onKeyDown"
      />
      <button class="btn ghost" id="hk-reset" type="button" @click="reset">恢复默认</button>
    </div>
    <div class="hk-presets" id="hk-presets" :hidden="presets.length === 0">
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
    <div class="hk-hint" :class="hintKind">{{ hintText }}</div>
    <label class="hk-sub">
      <input type="checkbox" id="hk-pintop" :checked="hk.pinTop !== false" @change="togglePinTop" />
      <span>
        唤出时强制置顶（最高优先级）：用最高层级压过其它置顶窗口和别的程序的全屏；
        窗口让出前台时自动取消，不会一直压着别人
      </span>
    </label>
    <label class="hk-sub">
      <input type="checkbox" id="hk-tray" :checked="hk.tray !== false" @change="toggleTray" />
      <span>显示托盘图标：窗口收进后台后仍然有一个能点回来的入口</span>
    </label>
    <label class="hk-sub">
      <input type="checkbox" id="hk-close" :checked="hk.closeToTray !== false" @change="toggleClose" />
      <span>点关闭按钮时收进后台而不是退出，这样快捷键随时能唤回（真正退出请用托盘图标的右键菜单）</span>
    </label>
  </div>
</template>

<script lang="ts">
export default { name: 'HotkeySection' };
</script>
