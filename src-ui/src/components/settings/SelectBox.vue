<script setup lang="ts">
// 下拉选择：档位多到一行放不下时用它（休眠时长就是这种）。
//
// 不用原生 select —— 展开列表是系统画的，字体、圆角、行高、选中态都不受 CSS 控制，
// 放在自绘的 .seg / .sw 旁边一眼就能看出是外来的。这里自己画，面板沿用 .st-menu
// 的外观（panel-bg + divider + 阴影），再把键盘、点外关闭、上下翻转补齐。
// 面板 Teleport 到 body：设置页的内容区是滚动容器，留在原地会被裁掉。
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
  label?: string;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

const open = ref(false);
const activeIndex = ref(0);
const btnEl = ref<HTMLButtonElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

const current = computed(
  () => props.options.find((o) => o.value === props.modelValue) || props.options[0]
);

function placeMenu() {
  const btn = btnEl.value;
  const menu = menuEl.value;
  if (!btn || !menu) return;

  const a = btn.getBoundingClientRect();
  // 与按钮严格等宽、左边缘对齐，展开时才像按钮「长」出来的，而不是另贴一块
  const width = a.width;
  const height = menu.offsetHeight;
  const gap = 6;
  const edge = 8;

  // 下方放不下就翻到上方；上下都放不下时贴住可见区底部，不越界
  let top = a.bottom + gap;
  if (top + height > window.innerHeight - edge) {
    const above = a.top - gap - height;
    top = above >= edge ? above : Math.max(edge, window.innerHeight - edge - height);
  }
  const left = Math.min(Math.max(edge, a.left), window.innerWidth - edge - width);

  menuStyle.value = {
    top: Math.round(top) + 'px',
    left: Math.round(left) + 'px',
    width: Math.round(width) + 'px',
    visibility: 'visible',
  };
}

function scrollActiveIntoView() {
  const items = menuEl.value?.querySelectorAll<HTMLElement>('.sel-opt');
  items?.[activeIndex.value]?.scrollIntoView({ block: 'nearest' });
}

async function openMenu() {
  if (open.value) return;
  const i = props.options.findIndex((o) => o.value === props.modelValue);
  activeIndex.value = i >= 0 ? i : 0;

  // 先藏起来再量，否则会在左上角闪一帧
  menuStyle.value = { top: '0px', left: '0px', visibility: 'hidden' };
  open.value = true;
  await nextTick();
  placeMenu();
  scrollActiveIntoView();

  document.addEventListener('mousedown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeydown, true);
  window.addEventListener('resize', placeMenu);
}

function closeMenu(focusBack = false) {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener('mousedown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', placeMenu);
  if (focusBack) btnEl.value?.focus();
}

function toggle() {
  if (open.value) closeMenu();
  else void openMenu();
}

function pick(index: number) {
  const opt = props.options[index];
  if (!opt) return;
  closeMenu(true);
  if (opt.value !== props.modelValue) emit('update:modelValue', opt.value);
}

function move(step: number) {
  const n = props.options.length;
  activeIndex.value = (activeIndex.value + step + n) % n;
  scrollActiveIntoView();
}

function onDocPointerDown(event: MouseEvent) {
  const t = event.target as Node;
  if (btnEl.value?.contains(t) || menuEl.value?.contains(t)) return;
  closeMenu();
}

function onDocKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      closeMenu(true);
      break;
    case 'ArrowDown':
      event.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      move(-1);
      break;
    case 'Home':
      event.preventDefault();
      activeIndex.value = 0;
      scrollActiveIntoView();
      break;
    case 'End':
      event.preventDefault();
      activeIndex.value = props.options.length - 1;
      scrollActiveIntoView();
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      pick(activeIndex.value);
      break;
    case 'Tab':
      closeMenu();
      break;
  }
}

function onButtonKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    void openMenu();
  }
}

onBeforeUnmount(() => closeMenu());
</script>

<template>
  <button
    ref="btnEl"
    class="sel"
    type="button"
    aria-haspopup="listbox"
    :aria-expanded="open ? 'true' : 'false'"
    :aria-label="label"
    @click="toggle"
    @keydown="onButtonKeydown"
  >
    <span class="sel-text">{{ current.label }}</span>
    <svg class="sel-arrow" viewBox="0 0 12 8" aria-hidden="true">
      <path
        d="M1.6 2.2 6 6.1l4.4-3.9"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="menuEl"
      class="sel-menu"
      role="listbox"
      :aria-label="label"
      :style="menuStyle"
      @click.stop
    >
      <button
        v-for="(opt, i) in options"
        :key="opt.value"
        class="sel-opt"
        :class="{ 'is-active': i === activeIndex }"
        type="button"
        role="option"
        :aria-selected="opt.value === modelValue ? 'true' : 'false'"
        @click="pick(i)"
        @mousemove="activeIndex = i"
      >
        <span class="sel-opt-label">{{ opt.label }}</span>
        <svg v-if="opt.value === modelValue" class="sel-check" viewBox="0 0 12 10" aria-hidden="true">
          <path
            d="M1.5 5.3 4.4 8l6.1-6.2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
  </Teleport>
</template>
