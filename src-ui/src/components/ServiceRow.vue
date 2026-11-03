<script setup lang="ts">
// 设置面板里的单行服务，对应原 index.html 的 serviceRow()。
import { computed, ref, watch } from 'vue';
import type { Service } from '@/api/types';
import { useOverlayStore } from '@/stores/overlay';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import { builtinIcon } from '@/utils/icons';

const props = defineProps<{ svc: Service; index: number; confirming: boolean }>();
const emit = defineEmits<{ (e: 'toggle-confirm', id: string): void; (e: 'removed', state: unknown): void }>();

const overlayStore = useOverlayStore();
const { toast } = useToast();

const name = ref(props.svc.name);
const url = ref(props.svc.url);

// 外部状态变化时同步输入框
watch(
  () => props.svc,
  (svc) => {
    name.value = svc.name;
    url.value = svc.url;
  },
);

const iconSrc = computed(() => builtinIcon(props.svc));

async function save() {
  const res = await api.updateService({ id: props.svc.id, name: name.value, url: url.value });
  if (!res || !res.ok) return toast((res && res.error) || '保存失败', true);
  toast('已保存「' + name.value.trim() + '」');
}

async function openDevtools() {
  api.activate(props.svc.id);
  overlayStore.setSettings(false);
  api.devtools(props.svc.id);
}

async function toggleHidden() {
  const res = await api.setServiceHidden(props.svc.id, !props.svc.hidden);
  if (!res || !res.ok) return toast((res && res.error) || '操作失败', true);
  toast(props.svc.hidden ? '已放回「' + props.svc.name + '」' : '已收起「' + props.svc.name + '」');
}

function confirmDelete() {
  emit('toggle-confirm', props.svc.id);
}

async function doRemove(wipe: boolean) {
  const res = await api.removeService(props.svc.id, wipe);
  if (!res || !res.ok) return toast((res && res.error) || '删除失败', true);
  if (res.state) emit('removed', res.state);
  toast(wipe ? '已删除并清除登录数据' : '已删除');
}
</script>

<template>
  <div
    class="svc-row"
    :class="{ confirming, 'hidden-svc': svc.hidden }"
    :style="{ '--i': String(Math.min(index, 8)) }"
  >
    <span class="svc-badge" :style="{ '--dot': svc.color }">
      <img v-if="iconSrc" :src="iconSrc" alt="" />
      <span v-else class="dot"></span>
    </span>

    <input v-model="name" type="text" maxlength="40" />
    <input v-model="url" type="url" />

    <div class="actions">
      <template v-if="confirming">
        <div class="confirm-text">确认删除「{{ svc.name }}」？删除后该服务不再显示在标签栏。</div>
        <button class="btn danger" @click="doRemove(false)">删除（保留登录数据）</button>
        <button class="btn danger" @click="doRemove(true)">删除并清除登录数据</button>
        <button class="btn ghost" @click="emit('toggle-confirm', svc.id)">取消</button>
      </template>
      <template v-else>
        <span v-if="svc.hidden" class="pill off" title="不在标签栏显示；登录态还在">已收起</span>
        <span v-if="!svc.custom" class="pill">内置</span>
        <button class="btn primary" @click="save">保存</button>
        <button class="btn ghost" @click="toggleHidden">{{ svc.hidden ? '放回顶栏' : '从顶栏收起' }}</button>
        <button class="btn ghost" title="打开该服务页面的开发者工具，排查登录或加载问题" @click="openDevtools">开发者工具</button>
        <button class="btn danger" @click="confirmDelete">删除</button>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'ServiceRow' };
</script>
