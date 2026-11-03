<script setup lang="ts">
// 账号迁移区块：把登录状态导出成加密文件，或从文件导入（支持先预演）。
import { computed, ref } from 'vue';
import type { LoginImportResult } from '@/api/types';
import { api } from '@/api';
import { useToast } from '@/composables/useToast';

const { toast } = useToast();

const password = ref('');
const note = ref('');
const noteKind = ref('');
const noteTitle = ref('');
const busy = ref(false);
const pendingImport = ref<{ file?: string; summary?: LoginImportResult } | null>(null);

const confirmLines = computed(() => {
  const summary = pendingImport.value && pendingImport.value.summary;
  if (!summary) return [];
  return (summary.services || []).map(
    (s) => `${s.name}：${s.cookies} 条 Cookie、${s.storages} 项本地存储`,
  );
});

const unmatched = computed(() => {
  const summary = pendingImport.value && pendingImport.value.summary;
  return (summary && summary.unmatched) || [];
});

function setNote(text: string, kind = '', title = '') {
  note.value = text;
  noteKind.value = kind;
  noteTitle.value = title;
}

/** 12345 -> "12.1 KB" */
function prettyBytes(n: number | undefined): string {
  const bytes = Number(n) || 0;
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function doExport() {
  toast('正在导出，请稍候…');
  busy.value = true;
  const res = await api.exportLogin(password.value);
  busy.value = false;
  if (!res || !res.ok) {
    if (res && res.canceled) return;
    return toast((res && res.error) || '导出失败', true);
  }
  const name = String(res.file).split(/[\\/]/).pop();
  setNote(
    `已导出 ${name} · ${res.services} 个服务 · ${res.cookies} 条 Cookie · ` +
      `${res.storages} 项本地存储 · ${prettyBytes(res.bytes)}` +
      (res.skipped ? ` · 已跳过 ${res.skipped} 项过期/统计数据` : '') +
      (res.encrypted ? ' · 已加密' : ' · 未加密，等同账号凭证，注意保管'),
    res.encrypted ? 'ok' : 'warn',
    res.file || '',
  );
  toast('已导出登录信息');
}

async function doImport() {
  const file = pendingImport.value ? pendingImport.value.file : '';
  const pwd = password.value;
  busy.value = true;
  const res = await api.importLogin({ file, password: pwd, dryRun: true });
  busy.value = false;
  if (!res || !res.ok) {
    if (res && res.canceled) return;
    if (res && res.needsPassword && res.file) pendingImport.value = { file: res.file };
    setNote((res && res.error) || '导入失败', 'warn');
    return toast('导入失败', true);
  }
  pendingImport.value = { file: res.file, summary: res };
  const services = res.services || [];
  const total = services.reduce((sum, s) => sum + s.cookies + s.storages, 0);
  setNote(
    `已选择文件（导出于 ${(res.exportedAt || '').slice(0, 10) || '未知时间'}），` +
      `共 ${services.length} 个服务、${total} 项登录信息${res.encrypted ? '，文件已加密' : ''}。请确认后导入。`,
  );
}

async function confirmImport() {
  if (!pendingImport.value) return;
  const file = pendingImport.value.file || '';
  pendingImport.value = null;
  busy.value = true;
  setNote('正在导入，导入后会自动刷新对应标签…');
  const res = await api.importLogin({ file, password: password.value, dryRun: false });
  busy.value = false;
  if (!res || !res.ok) {
    if (res && res.needsPassword && res.file) pendingImport.value = { file: res.file };
    setNote((res && res.error) || '导入失败', 'warn');
    return toast('导入失败', true);
  }
  const services = res.services || [];
  const total = services.reduce((sum, s) => sum + s.cookies + s.storages, 0);
  const failed = services.reduce((sum, s) => sum + (s.failed || 0), 0);
  setNote(
    `导入完成：${services.length} 个服务，共恢复 ${total} 项` +
      (failed ? `，${failed} 条 Cookie 写入被拒绝` : '') +
      '。若页面仍显示未登录，按 F5 刷新该标签即可。',
    failed ? 'warn' : 'ok',
  );
  toast('登录信息已导入');
}

function cancelImport() {
  pendingImport.value = null;
  setNote('已取消导入。');
}
</script>

<template>
  <div class="migrate">
    <div class="migrate-head">
      <strong>账号迁移</strong>
      <span>导出各服务的登录状态成一个文件，在另一台设备导入即可继续用，不用重新登录</span>
    </div>
    <div class="migrate-row">
      <input v-model="password" type="password" id="migrate-pass" placeholder="可选：给导出文件设置密码" autocomplete="new-password" />
      <button class="btn" id="btn-export-login" :disabled="busy" @click="doExport">导出登录信息</button>
      <button class="btn" id="btn-import-login" :disabled="busy" @click="doImport">导入登录信息</button>
    </div>
    <div class="migrate-note" id="migrate-note" :class="noteKind" :title="noteTitle || undefined">
      {{ note || '文件里是 Cookie 和本地存储（等同账号凭证），只在自己信任的设备之间传递；填了密码就用 AES-256-GCM 加密。' }}
    </div>
    <div id="migrate-confirm" :hidden="!pendingImport || !pendingImport.summary">
      <div v-if="pendingImport && pendingImport.summary" class="confirm-text">
        即将导入以下登录信息，同名项会被覆盖：<br />
        <span v-for="(line, i) in confirmLines" :key="i">{{ line }}<br /></span>
        <span v-if="unmatched.length">
          <br />当前应用里没有对应服务、将跳过：{{ unmatched.map((u) => u.name).join('、') }}
        </span>
        <br />确认后这些标签会自动刷新一次。
      </div>
      <div class="actions">
        <button class="btn primary" id="btn-import-confirm" @click="confirmImport">确认导入</button>
        <button class="btn" @click="cancelImport">取消</button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'MigrateSection' };
</script>
