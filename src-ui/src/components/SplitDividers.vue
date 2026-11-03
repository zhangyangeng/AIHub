<script setup lang="ts">
// 分隔条组件：按 layout store 的几何信息渲染，拖拽逻辑在 useDividerDrag 里。
import { useLayoutStore } from '@/stores/layout';
import { useDividerDrag } from '@/composables/useDividerDrag';

const layoutStore = useLayoutStore();
const { onDividerDown, onDividerDoubleClick, dividerStyle } = useDividerDrag();
</script>

<template>
  <div id="split-layer" :hidden="!layoutStore.dividersVisible">
    <div
      v-for="(info, i) in layoutStore.dividers"
      :key="info.index + '-' + i"
      class="divider"
      :data-index="info.index"
      :style="dividerStyle(info)"
      title="拖动调整两栏宽度，双击均分"
      @pointerdown="onDividerDown"
      @dblclick="onDividerDoubleClick"
    ></div>
  </div>
</template>
