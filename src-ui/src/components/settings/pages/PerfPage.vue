<script setup lang="ts">
// 性能页：后台休眠时长、启动预加载。两项都是「拿内存换体验」的取舍，文案只讲代价。
import { computed } from 'vue';
import { useAppStore } from '@/stores/app';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import SettingRow from '@/components/settings/SettingRow.vue';
import SwitchBox from '@/components/settings/SwitchBox.vue';
import SegBox from '@/components/settings/SegBox.vue';

const appStore = useAppStore();
const { toast } = useToast();

const NAPS = [
  { value: '15', label: '15 分钟' },
  { value: '30', label: '30 分钟' },
  { value: '120', label: '2 小时' },
  { value: 'off', label: '不休眠' },
];

const nap = computed(() => {
  const cfg = appStore.hibernate || {};
  return cfg.enabled === false ? 'off' : String(cfg.minutes || 30);
});

async function setNap(value: string) {
  const payload = value === 'off' ? { enabled: false } : { enabled: true, minutes: Number(value) };
  const res = await api.setHibernate(payload);
  if (!res || !res.ok) return toast((res && res.error) || '设置失败', true);
  appStore.apply({ ...appStore.$state, hibernate: res.hibernate });
}

async function setPreload(on: boolean) {
  const res = await api.setPreload(on);
  if (!res || !res.ok) return toast('设置失败', true);
  appStore.apply({ ...appStore.$state, preload: Boolean(res.preload) });
}
</script>

<template>
  <div class="st-page">
    <div class="st-page-bar">
      <div>
        <h2>性能</h2>
        <p class="st-sub">内存和启动速度的取舍</p>
      </div>
    </div>

    <div class="st-group">
      <div class="st-group-title">内存</div>
      <SettingRow
        title="后台标签自动休眠"
        desc="闲置的后台标签会释放内存，点回去从原处继续。正在显示、播放声音或还写着字的标签不会被休眠。"
      >
        <SegBox :model-value="nap" :options="NAPS" label="后台标签自动休眠" @update:model-value="setNap" />
      </SettingRow>
    </div>

    <div class="st-group">
      <div class="st-group-title">启动</div>
      <SettingRow title="启动时加载全部标签" desc="标签栏能更快显示各站点自己的标题，代价是启动更慢、内存占用更高。">
        <SwitchBox
          :model-value="appStore.preload !== false"
          label="启动时加载全部标签"
          @update:model-value="setPreload"
        />
      </SettingRow>
    </div>
  </div>
</template>
