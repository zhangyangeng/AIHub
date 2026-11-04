<script setup lang="ts">
// 站点页：服务列表 + 添加入口。操作收在行尾菜单，编辑和删除走对话框。
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { AppState, Service } from '@/api/types';
import { useAppStore } from '@/stores/app';
import { useOverlayStore } from '@/stores/overlay';
import ServiceRow from '@/components/settings/ServiceRow.vue';
import ServiceEditor from '@/components/settings/ServiceEditor.vue';
import RemoveServiceDialog from '@/components/settings/RemoveServiceDialog.vue';
import CustomAddDialog from '@/components/settings/CustomAddDialog.vue';

const appStore = useAppStore();
const overlayStore = useOverlayStore();

const services = computed(() => appStore.services);
const menuId = ref<string | null>(null);
const editing = ref<Service | null>(null);
const removing = ref<Service | null>(null);

function openAdd() {
  overlayStore.setAddPanel(true);
}

/** 点空白处、滚动、改窗口大小都收起菜单：菜单按按钮位置一次性定位，离开原位就没意义了。 */
function dismissMenu() {
  if (menuId.value) menuId.value = null;
}

function onRemoved(state: unknown) {
  if (state) appStore.apply(state as AppState);
}

onMounted(() => {
  document.addEventListener('click', dismissMenu);
  // scroll 不冒泡，只有捕获阶段才收得到 .st-main 内部的滚动
  document.addEventListener('scroll', dismissMenu, true);
  window.addEventListener('resize', dismissMenu);
});
onUnmounted(() => {
  document.removeEventListener('click', dismissMenu);
  document.removeEventListener('scroll', dismissMenu, true);
  window.removeEventListener('resize', dismissMenu);
});
</script>

<template>
  <div class="st-page">
    <div class="st-page-bar">
      <div>
        <h2>站点</h2>
        <p class="st-sub">标签栏里显示的服务。拖动顶栏上的标签可以调整顺序。</p>
      </div>
      <button class="btn primary" type="button" @click="openAdd">添加服务</button>
    </div>

    <div class="st-list">
      <p v-if="services.length === 0" class="st-empty">
        还没有任何服务。<br />
        点「添加服务」挑一个常用的，或者直接填个网址。
      </p>
      <ServiceRow
        v-for="svc in services"
        :key="svc.id"
        :svc="svc"
        :menu-open="menuId === svc.id"
        :pane-count="appStore.panes.length"
        :pane-ids="appStore.panes"
        @menu="menuId = $event"
        @edit="editing = $event"
        @remove="removing = $event"
      />
    </div>

    <button class="st-addbox" type="button" @click="openAdd">
      <span aria-hidden="true">＋</span>
      从内置站点添加，或填写任意网址
    </button>

    <ServiceEditor v-if="editing" :svc="editing" @close="editing = null" />
    <RemoveServiceDialog
      v-if="removing"
      :svc="removing"
      @close="removing = null"
      @removed="onRemoved"
    />
    <CustomAddDialog v-if="overlayStore.customAddOpen" />
  </div>
</template>
