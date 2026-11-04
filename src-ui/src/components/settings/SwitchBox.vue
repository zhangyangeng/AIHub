<script setup lang="ts">
// 开关：全应用只用这一种「开 / 关」控件。
// 用 button[role=switch] 而不是 input[type=checkbox]：勾选框 16px 的视觉重量
// 和右侧的开关不一致，且原生勾选框没法做 thumb 位移过渡。
const props = defineProps<{ modelValue: boolean; label?: string; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();

function toggle() {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
}
</script>

<template>
  <button
    class="sw"
    type="button"
    role="switch"
    :aria-checked="modelValue ? 'true' : 'false'"
    :aria-label="label"
    :disabled="disabled"
    @click="toggle"
  >
    <i aria-hidden="true"></i>
  </button>
</template>
