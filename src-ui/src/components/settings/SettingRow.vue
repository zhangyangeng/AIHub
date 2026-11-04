<script setup lang="ts">
// 一行设置：左边标题 + 一句话说明，右边控件。
// 说明只写「这项设置对用户意味着什么」，实现细节（进程、像素、算法名）不进这里。
defineProps<{ title: string; desc?: string; mono?: boolean }>();
</script>

<template>
  <div class="st-row">
    <div class="st-row-main">
      <div class="st-row-title">{{ title }}</div>
      <div v-if="desc" class="st-row-desc" :class="{ mono }">{{ desc }}</div>
      <slot name="extra" />
    </div>
    <div class="st-row-ctl">
      <slot />
    </div>
  </div>
</template>
