<script setup lang="ts">
// 性能页：后台休眠时长。属于「拿内存换体验」的取舍，文案只讲代价。
import { computed } from 'vue';
import { useAppStore } from '@/stores/app';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import SettingRow from '@/components/settings/SettingRow.vue';
import SelectBox from '@/components/settings/SelectBox.vue';

const appStore = useAppStore();
const { toast } = useToast();

// 档位一多一行就放不下，所以用下拉框。最小档 5 分钟——休眠判定只看「不在分屏 + 闲置够久」，
// 没有「输入框里还有字」的豁免，再短的档位会把用户切走前没写完的草稿一起卸掉。
const NAPS = [
  { value: '5', label: '5 分钟' },
  { value: '10', label: '10 分钟' },
  { value: '15', label: '15 分钟' },
  { value: '30', label: '30 分钟' },
  { value: '60', label: '1 小时' },
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
        desc="闲置的后台标签会被卸载以释放内存，点回去重新加载。分屏里正显示着的标签不受影响。"
      >
        <SelectBox :model-value="nap" :options="NAPS" label="后台标签自动休眠" @update:model-value="setNap" />
      </SettingRow>
    </div>
  </div>
</template>
