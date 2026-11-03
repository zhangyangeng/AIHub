<script setup lang="ts">
// 田字格投放区 + 拖拽幽灵。
// 数据由 useTabDrag 维护（dropTargets / hotIndex / dragGhost），这里只负责渲染。
import { useTabDrag } from '@/composables/useTabDrag';

const { dropTargets, hotIndex, dragActive, dragGhostName, dragGhostPos } = useTabDrag();
</script>

<template>
  <div id="dropzones" aria-hidden="true">
    <div
      v-for="t in dropTargets"
      :key="t.index"
      class="dz"
      :class="{ empty: !t.occupied, hot: hotIndex === t.index }"
      :data-label="t.label"
      :style="{ left: t.rect.x + 'px', top: t.rect.y + 'px', width: t.rect.w + 'px', height: t.rect.h + 'px' }"
    >
      <div v-if="t.ownerName" class="dz-owner">{{ t.ownerName }}</div>
    </div>
  </div>

  <!-- 跟着指针的小标签影子 -->
  <div
    v-if="dragActive"
    class="tab-ghost"
    :style="{ left: dragGhostPos.x + 'px', top: dragGhostPos.y + 'px' }"
  >
    {{ dragGhostName }}
  </div>
</template>
