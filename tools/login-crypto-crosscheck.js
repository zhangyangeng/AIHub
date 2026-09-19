/**
 * 登录信息文件的跨运行时互通性检查。
 *
 *   node tools/login-crypto-crosscheck.js
 *
 * 两个方向各验一次，防止哪天有人「顺手」换掉 KDF 参数或 tag 的摆放方式：
 *
 *   Node 加密 → Rust 解密   由 cargo test 的 files_exported_by_the_electron_version_still_open 覆盖
 *   Rust 加密 → Node 解密   就是这个脚本
 *
 * fixture 由 `cargo test emit_envelope_for_node -- --ignored --nocapture` 生成。
 * 这里用的是 Node 内置 crypto，和 Electron 版 main.js 的 decryptLogin 同一套调用，
 * 所以它解得开就等于「老应用也解得开」。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PASSWORD = 'crosscheck-password';
const file = path.join(__dirname, 'fixtures', 'login-rust-encrypted.json');
const env = JSON.parse(fs.readFileSync(file, 'utf8'));

const problems = [];
const eq = (actual, want, what) => {
  if (actual !== want) problems.push(`${what}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
};

eq(env.format, 'aihub-login', 'format');
eq(env.encrypted, true, 'encrypted');
eq(env.cipher, 'aes-256-gcm', 'cipher');
eq(env.kdf, 'scrypt', 'kdf');
eq(Buffer.from(env.salt, 'base64').length, 16, 'salt 字节数');
eq(Buffer.from(env.iv, 'base64').length, 12, 'iv 字节数');
eq(Buffer.from(env.tag, 'base64').length, 16, 'tag 字节数');

let payload = null;
try {
  // 和 Electron 版 decryptLogin 一模一样的调用
  const key = crypto.scryptSync(PASSWORD, Buffer.from(env.salt, 'base64'), 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  payload = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(env.data, 'base64')),
    decipher.final(),
  ]).toString('utf8'));
} catch (err) {
  problems.push(`Node 解不开 Rust 加的密：${err.message}`);
}

if (payload) {
  const svc = (payload.services || [])[0] || {};
  const cookie = (svc.cookies || [])[0] || {};
  eq(svc.id, 'chatgpt', 'services[0].id');
  eq(cookie.name, '__Secure-next-auth.session-token', 'cookie 名');
  eq(cookie.httpOnly, true, 'httpOnly 必须是 camelCase 且为 true');
  eq(cookie.domain, '.chatgpt.com', 'domain');
  const origin = (svc.origins || [])[0] || {};
  eq(origin.origin, 'https://chatgpt.com', 'origins[0].origin');
  eq(origin.localStorage && origin.localStorage.token, 't', '本地存储要按 localStorage 这个键名写');
}

if (problems.length) {
  console.error('❌ 互通性检查未通过：');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('✅ Rust 加密的文件，Node（即 Electron 版那套）能原样解开，字段名也对得上');
