<script setup lang="ts">
// 分段控件：只用于「3 个以上互斥档位、且需要同时看见所有选项」的场合（主题、休眠时长）。
// 两档的开关用 SwitchBox，不要用它——两个选项的段控看起来像个坏掉的按钮组。
import { computed } from 'vue';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
  label?: string;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

const index = computed(() => {
  const i = props.options.findIndex((o) => o.value === props.modelValue);
  return i >= 0 ? i : 0;
});

const thumbStyle = computed(() => ({
  width: 'calc((100% - 4px) / ' + props.options.length + ')',
  transform: 'translateX(' + index.value * 100 + '%)',
}));

function onKeydown(event: KeyboardEvent) {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
    : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
      : 0;
  if (!step) return;
  event.preventDefault();
  const next = (index.value + step + props.options.length) % props.options.length;
  emit('update:modelValue', props.options[next].value);
}
</script>

<template>
  <div class="seg" role="radiogroup" :aria-label="label" @keydown="onKeydown">
    <span class="seg-thumb" aria-hidden="true" :style="thumbStyle"></span>
    <button
      v-for="opt in options"
      :key="opt.value"
      class="seg-btn"
      type="button"
      role="radio"
      :aria-checked="opt.value === modelValue ? 'true' : 'false'"
      :tabindex="opt.value === modelValue ? 0 : -1"
      @click="emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>
