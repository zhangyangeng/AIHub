<script setup lang="ts">
// 编辑服务对话框：名称和网址。主按钮只在真的有改动时可点。
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { Service } from '@/api/types';
import { api } from '@/api';
import { useToast } from '@/composables/useToast';

const props = defineProps<{ svc: Service }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { toast } = useToast();

const name = ref(props.svc.name);
const url = ref(props.svc.url);
const saving = ref(false);
const nameEl = ref<HTMLInputElement | null>(null);

const dirty = computed(
  () => name.value.trim() !== props.svc.name || url.value.trim() !== props.svc.url,
);

async function save() {
  if (!dirty.value || saving.value) return;
  saving.value = true;
  const res = await api.updateService({ id: props.svc.id, name: name.value, url: url.value });
  saving.value = false;
  if (!res || !res.ok) return toast((res && res.error) || '保存失败', true);
  toast('已保存「' + name.value.trim() + '」');
  emit('close');
}

/**
 * Esc 先关对话框，而不是关整个设置面板。
 * 用捕获阶段拦下来：App.vue 的 Esc 处理器挂在冒泡阶段，收不到就不会误关面板。
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  emit('close');
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown, true);
  await nextTick();
  if (nameEl.value) {
    nameEl.value.focus();
    nameEl.value.select();
  }
});

onUnmounted(() => document.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <Teleport to="body">
    <div class="st-modal" @click.self="emit('close')">
      <div class="st-dialog" role="dialog" aria-modal="true" aria-label="编辑服务">
        <h3>编辑服务</h3>
        <p class="st-dialog-desc">改完点保存，标签栏会立刻更新。</p>

        <div class="st-field">
          <label for="svc-edit-name">名称</label>
          <input
            id="svc-edit-name"
            ref="nameEl"
            v-model="name"
            type="text"
            maxlength="40"
            @keydown.enter="save"
          />
        </div>

        <div class="st-field">
          <label for="svc-edit-url">网址</label>
          <input id="svc-edit-url" v-model="url" type="url" @keydown.enter="save" />
        </div>

        <div class="st-dialog-actions">
          <button class="btn ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn primary" type="button" :disabled="!dirty || saving" @click="save">保存</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
