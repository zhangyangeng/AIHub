<script setup lang="ts">
// 删除服务确认：把「是否连登录数据一起删」做成一个勾选项，
// 而不是并排两个同等重量的危险按钮——两者危险程度并不相同。
import { onMounted, onUnmounted, ref } from 'vue';
import type { Service } from '@/api/types';
import { api } from '@/api';
import { useToast } from '@/composables/useToast';

const props = defineProps<{ svc: Service }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'removed', state: unknown): void }>();

const { toast } = useToast();
const wipe = ref(false);
const busy = ref(false);

async function confirm() {
  if (busy.value) return;
  busy.value = true;
  const res = await api.removeService(props.svc.id, wipe.value);
  busy.value = false;
  if (!res || !res.ok) return toast((res && res.error) || '删除失败', true);
  emit('removed', res.state);
  toast(wipe.value ? '已删除并清除登录数据' : '已删除');
  emit('close');
}

/** Esc 只关这个确认框，不关整个设置面板（理由同 ServiceEditor） */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown, true));
onUnmounted(() => document.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <Teleport to="body">
    <div class="st-modal" @click.self="emit('close')">
      <div class="st-dialog" role="dialog" aria-modal="true" aria-label="删除服务">
        <h3>删除「{{ svc.name }}」？</h3>
        <p class="st-dialog-desc">删除后它不再出现在标签栏上。登录数据默认保留，可以下次再加回来。</p>

        <label class="st-check">
          <input v-model="wipe" type="checkbox" />
          <span>同时清除这个服务的登录数据（不可恢复）</span>
        </label>

        <div class="st-dialog-actions">
          <button class="btn ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn danger-solid" type="button" :disabled="busy" @click="confirm">删除</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
