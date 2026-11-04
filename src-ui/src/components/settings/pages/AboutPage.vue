<script setup lang="ts">
// 关于页：版本、检查更新、仓库链接。
import { onMounted, onUnmounted, ref } from 'vue';
import { useAppStore } from '@/stores/app';
import { api } from '@/api';
import SettingRow from '@/components/settings/SettingRow.vue';

const appStore = useAppStore();

const REPO = 'https://github.com/zhangyangeng/AIHub';

const version = ref('');
const updateHint = ref('');
const checking = ref(false);
const hasUpdate = ref(false);
const updating = ref(false);

async function loadVersion() {
  try {
    const v = await api.getVersion();
    version.value = String(v);
  } catch {
    version.value = appStore.version || '';
  }
}

async function checkUpdate() {
  checking.value = true;
  updateHint.value = '正在检查…';
  try {
    const info = await api.checkUpdate();
    if (info.error) {
      updateHint.value = '检查失败：' + info.error;
    } else if (info.available) {
      updateHint.value = '发现新版本 v' + info.version;
      hasUpdate.value = true;
    } else {
      updateHint.value = '已是最新版本。';
      hasUpdate.value = false;
    }
  } catch (err) {
    updateHint.value = '检查失败：' + err;
  } finally {
    checking.value = false;
  }
}

async function installUpdate() {
  updating.value = true;
  updateHint.value = '正在下载…';
  try {
    await api.installUpdate();
  } catch (err) {
    updateHint.value = '更新失败：' + err;
    updating.value = false;
  }
}

function onProgress(p: { phase?: string } | null | undefined) {
  if (!p) return;
  if (p.phase === 'downloading') updateHint.value = '正在下载新版本…';
  if (p.phase === 'closing') updateHint.value = '正在关闭所有页面，准备安装…';
}

let unlisten: (() => void) | null = null;

onMounted(() => {
  loadVersion();
  unlisten = api.onUpdateProgress((p) => onProgress(p));
});
onUnmounted(() => {
  if (unlisten) unlisten();
});
</script>

<template>
  <div class="st-page">
    <div class="st-page-bar">
      <div>
        <h2>关于</h2>
        <p class="st-sub">版本与开源信息</p>
      </div>
    </div>

    <div class="st-group">
      <SettingRow title="Aihub" :desc="'当前版本 ' + (version || appStore.version || '读取中…')">
        <button class="btn" type="button" :disabled="checking" @click="checkUpdate">检查更新</button>
        <button v-if="hasUpdate" class="btn primary" type="button" :disabled="updating" @click="installUpdate">
          下载并重启
        </button>
      </SettingRow>
      <div v-if="updateHint" class="st-status" :class="hasUpdate ? 'ok' : ''">{{ updateHint }}</div>
    </div>

    <div class="st-group">
      <div class="st-group-title">链接</div>
      <button class="st-link" type="button" @click="api.openExternal(REPO)">
        <span>GitHub 仓库</span>
        <span class="st-link-note">zhangyangeng/AIHub</span>
      </button>
      <button class="st-link" type="button" @click="api.openExternal(REPO + '/releases')">
        <span>更新日志</span>
        <span class="st-link-note">Releases</span>
      </button>
      <button class="st-link" type="button" @click="api.openExternal(REPO + '/blob/main/LICENSE')">
        <span>开源协议</span>
        <span class="st-link-note">MIT</span>
      </button>
    </div>
  </div>
</template>
