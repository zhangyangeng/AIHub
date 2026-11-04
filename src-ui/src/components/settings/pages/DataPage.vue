<script setup lang="ts">
// 数据页：账号迁移（导出 / 导入分开）+ 本地数据目录。
// 导出和导入共用一行一个密码框是错的：一个的密码是「给新文件加密」，
// 另一个是「解开已有文件」，是两个不同的动作。
import { computed, ref } from 'vue';
import type { LoginImportResult } from '@/api/types';
import { useAppStore } from '@/stores/app';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import SettingRow from '@/components/settings/SettingRow.vue';

const appStore = useAppStore();
const { toast } = useToast();

const exportPwd = ref('');
const exporting = ref(false);
const exportNote = ref('');
const exportKind = ref('');

const importPwd = ref('');
const importing = ref(false);
const needPwd = ref(false);
const pending = ref<{ file?: string; summary?: LoginImportResult } | null>(null);
const importNote = ref('');
const importKind = ref('');

const dataDir = computed(() => appStore.userData || '%APPDATA%\\Aihub');

const confirmLines = computed(() => {
  const summary = pending.value && pending.value.summary;
  if (!summary) return [];
  return (summary.services || []).map((s) => s.name + '：' + s.cookies + ' 条 Cookie、' + s.storages + ' 项本地存储');
});

const unmatched = computed(() => {
  const summary = pending.value && pending.value.summary;
  return (summary && summary.unmatched) || [];
});

/** 12345 -> "12.1 KB" */
function prettyBytes(n: number | undefined): string {
  const bytes = Number(n) || 0;
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function doExport() {
  exporting.value = true;
  const res = await api.exportLogin(exportPwd.value);
  exporting.value = false;
  if (!res || !res.ok) {
    if (res && res.canceled) return;
    exportNote.value = (res && res.error) || '导出失败';
    exportKind.value = 'warn';
    return toast('导出失败', true);
  }
  const fileName = String(res.file).split(/[\\/]/).pop();
  exportNote.value =
    '已导出 ' + fileName + ' · ' + res.services + ' 个服务 · ' + prettyBytes(res.bytes) +
    (res.encrypted ? ' · 已加密' : ' · 未加密，注意保管');
  exportKind.value = res.encrypted ? 'ok' : 'warn';
  toast('已导出登录信息');
}

async function pickFile() {
  importing.value = true;
  const res = await api.importLogin({
    file: pending.value ? pending.value.file : '',
    password: importPwd.value,
    dryRun: true,
  });
  importing.value = false;

  if (!res || !res.ok) {
    if (res && res.canceled) return;
    if (res && res.needsPassword && res.file) {
      pending.value = { file: res.file };
      needPwd.value = true;
      importNote.value = '这个文件是加密的，请输入导出时设置的密码。';
      importKind.value = 'warn';
      return;
    }
    importNote.value = (res && res.error) || '读取失败';
    importKind.value = 'warn';
    return toast('导入失败', true);
  }

  pending.value = { file: res.file, summary: res };
  needPwd.value = false;
  importNote.value =
    '文件导出于 ' + ((res.exportedAt || '').slice(0, 10) || '未知时间') +
    '，共 ' + (res.services || []).length + ' 个服务。确认后会覆盖同名服务的登录状态。';
  importKind.value = '';
}

async function confirmImport() {
  if (!pending.value) return;
  const file = pending.value.file || '';
  importing.value = true;
  const res = await api.importLogin({ file, password: importPwd.value, dryRun: false });
  importing.value = false;
  if (!res || !res.ok) {
    importNote.value = (res && res.error) || '导入失败';
    importKind.value = 'warn';
    return toast('导入失败', true);
  }
  const services = res.services || [];
  const failed = services.reduce((sum, s) => sum + (s.failed || 0), 0);
  pending.value = null;
  importPwd.value = '';
  needPwd.value = false;
  importNote.value =
    '导入完成：' + services.length + ' 个服务' +
    (failed ? '，' + failed + ' 条 Cookie 写入被拒绝' : '') +
    '。若页面仍显示未登录，按 F5 刷新该标签即可。';
  importKind.value = failed ? 'warn' : 'ok';
  toast('登录信息已导入');
}

function cancelImport() {
  pending.value = null;
  needPwd.value = false;
  importPwd.value = '';
  importNote.value = '';
  importKind.value = '';
}

async function copyDataDir() {
  const text = dataDir.value;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制路径');
    return;
  } catch {
    // 剪贴板 API 在一些 webview 里不可用，退回选区复制
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
    toast('已复制路径');
  } catch {
    toast('复制失败，请手动选中', true);
  }
  document.body.removeChild(area);
}
</script>

<template>
  <div class="st-page">
    <div class="st-page-bar">
      <div>
        <h2>数据</h2>
        <p class="st-sub">登录状态和数据目录</p>
      </div>
    </div>

    <div class="st-group">
      <div class="st-group-title">账号迁移</div>

      <div class="st-card">
        <h3>导出登录状态</h3>
        <p>换设备后导入这个文件就能继续用，不用重新登录。文件等同于账号凭证，只在自己信任的设备之间传递。</p>
        <div class="st-inline">
          <input v-model="exportPwd" type="password" placeholder="设置密码（可选，用于加密文件）" autocomplete="new-password" />
          <button class="btn" type="button" :disabled="exporting" @click="doExport">导出…</button>
        </div>
        <div v-if="exportNote" class="st-status" :class="exportKind" style="margin-top:10px;">{{ exportNote }}</div>
      </div>

      <div class="st-card">
        <h3>导入登录状态</h3>
        <p>选择之前导出的文件。导入前会先列出内容让你确认，同名服务会被覆盖。</p>
        <div class="st-inline">
          <input
            v-if="needPwd"
            v-model="importPwd"
            type="password"
            placeholder="导出时设置的密码"
            autocomplete="off"
            @keydown.enter="pickFile"
          />
          <button class="btn" type="button" :disabled="importing" @click="pickFile">
            {{ pending ? '重新选择…' : '选择文件…' }}
          </button>
        </div>

        <div v-if="importNote" class="st-status" :class="importKind" style="margin-top:10px;">{{ importNote }}</div>

        <div v-if="pending && pending.summary" style="margin-top:12px;">
          <div class="st-row-desc" style="margin-bottom:8px;">
            即将导入以下登录信息，同名项会被覆盖：
            <div v-for="(line, i) in confirmLines" :key="i" style="margin-top:4px;">{{ line }}</div>
            <div v-if="unmatched.length" style="margin-top:8px;">
              当前没有对应服务、将跳过：{{ unmatched.map((u) => u.name).join('、') }}
            </div>
          </div>
          <div class="st-inline">
            <button class="btn primary" type="button" :disabled="importing" @click="confirmImport">确认导入</button>
            <button class="btn ghost" type="button" @click="cancelImport">取消</button>
          </div>
        </div>
      </div>
    </div>

    <div class="st-group">
      <div class="st-group-title">本地数据</div>
      <SettingRow title="数据目录" :desc="dataDir" mono>
        <button class="btn" type="button" @click="copyDataDir">复制路径</button>
      </SettingRow>
      <SettingRow title="登录态只保存在本机" desc="不会上传到任何服务器。卸载应用不会删除这里的数据。" />
    </div>
  </div>
</template>
