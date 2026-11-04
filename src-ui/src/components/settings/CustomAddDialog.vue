<script setup lang="ts">
// 添加自定义网站：填名称和网址即可新增一个标签。
// 这是原来设置面板顶部那个常驻表单的唯一去处——它不属于「列表」，属于一次动作。
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useOverlayStore } from '@/stores/overlay';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';

const overlayStore = useOverlayStore();
const { toast } = useToast();

const name = ref('');
const url = ref('');
const busy = ref(false);
const nameEl = ref<HTMLInputElement | null>(null);

const canAdd = computed(() => name.value.trim().length > 0 && url.value.trim().length > 0);

function close() {
  overlayStore.setCustomAdd(false);
}

async function add() {
  if (!canAdd.value || busy.value) return;
  const trimmedName = name.value.trim();
  busy.value = true;
  const res = await api.addService({ name: name.value, url: url.value });
  busy.value = false;
  if (!res || !res.ok) return toast((res && res.error) || '添加失败', true);
  toast('已添加「' + trimmedName + '」');
  if (res.id) api.activate(res.id);
  close();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  close();
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown, true);
  await nextTick();
  if (nameEl.value) nameEl.value.focus();
});

onUnmounted(() => document.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <Teleport to="body">
    <div class="st-modal" @click.self="close">
      <div class="st-dialog" role="dialog" aria-modal="true" aria-label="添加自定义网站">
        <h3>添加自定义网站</h3>
        <p class="st-dialog-desc">填名字和网址就能加一个标签，登录态会单独保存在本机。</p>

        <div class="st-field">
          <label for="svc-add-name">名称</label>
          <input
            id="svc-add-name"
            ref="nameEl"
            v-model="name"
            type="text"
            maxlength="40"
            placeholder="比如 Kimi"
            @keydown.enter="add"
          />
        </div>

        <div class="st-field">
          <label for="svc-add-url">网址</label>
          <input
            id="svc-add-url"
            v-model="url"
            type="url"
            placeholder="https://kimi.moonshot.cn"
            @keydown.enter="add"
          />
        </div>

        <div class="st-dialog-actions">
          <button class="btn ghost" type="button" @click="close">取消</button>
          <button class="btn primary" type="button" :disabled="!canAdd || busy" @click="add">添加</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
