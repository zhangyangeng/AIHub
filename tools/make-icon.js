'use strict';

/**
 * 生成品牌素材（纯 Node：PNG 解码/编码用内置 zlib，不依赖任何第三方包）。
 *
 *   npm run icon              # 生成
 *   npm run icon -- --check   # 只检查产物是不是最新（CI 用，不写盘）
 *
 * 源图：assets/brand/logo-source.png（设计稿原图，完整锁版：图形 + Aihub 字标）
 *
 * 产物：
 *   build/icon.ico              多分辨率图标（16/32/48/64/128/256，BMP 条目，兼容性最好）
 *   build/icon.png              1024x1024 图形（打包用：Windows 图标 + macOS 的 icns 来源）
 *   build/tray.png              32x32 Windows 托盘图标
 *   build/tray@2x.png           64x64 高分屏版本
 *   build/tray-mac.png          22x22 macOS 菜单栏图标（菜单栏就是 22pt 高）
 *   build/tray-mac@2x.png       44x44 Retina 版本
 *   assets/brand/logo.png       裁掉多余留白的完整锁版（README 用）
 *   assets/brand/logo-mark.png  512x512 图形（正方形，居中留边）
 *
 * 关键点一：源图是「图形在上、字标在下」的锁版，直接缩成方图当图标，字会糊成一团。
 * 所以这里先用 alpha 通道把图形那一段切出来（顶部连续非空行），再裁成正方形加留白。
 *
 * 关键点二：方形裁剪框允许超出源图边界，超出的部分补透明。早先这里把 sx/sy 夹在
 * [0, W-side] 里，而图形长边 * 留边系数 已经大于源图宽度，于是裁剪框被夹成「整幅源图」，
 * 留边系数完全没生效，图形在源图里本来的偏移也直接透到成品上（左右留白 91 / 56，
 * 肉眼可见地右偏）。现在按图形中心居中裁，不夹边界。
 *
 * 关键点三：缩放走「面积平均 + alpha 预乘」。不做预乘的话，透明像素里的黑色会渗到
 * 图形边缘，缩完一圈发灰的黑边——托盘那种 16~22px 的尺寸上特别明显。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SOURCE = process.env.AIHUB_ICON_SOURCE || path.join(ROOT, 'assets', 'brand', 'logo-source.png');
const BRAND_DIR = path.join(ROOT, 'assets', 'brand');
const BUILD_DIR = path.join(ROOT, 'build');

const CHECK_ONLY = process.argv.includes('--check');

// 图标里每一档都要有：小尺寸给任务栏/资源管理器，大尺寸给高分屏
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
// 1024 是 macOS 图标的标准尺寸（打包工具用它现场转 icns，所以不能小于 512）
const ICON_PNG = 1024;   // build/icon.png
const LOCKUP_MAX = 1024; // assets/brand/logo.png 的长边上限
const MARK_PNG = 512;    // assets/brand/logo-mark.png
const TRAY_PNG = 32;     // build/tray.png（Windows 托盘，16px 下也要看得清）
const TRAY_MAC = 22;     // build/tray-mac.png（macOS 菜单栏，22pt；@2x 就是 44）
// 留边系数 = 画布边长 / 图形长边。1024/824 对应 Apple HIG 的图标网格：
// 不带圆角方底的「自由形」图标，长边就是占 824/1024 ≈ 80.5%。
const MARGIN = 1024 / 824;
// Windows 托盘只有 16px，图形要尽量占满，不然缩完就是一小团看不清的东西
const TRAY_MARGIN = 1.02;
// macOS 菜单栏 22pt 高，系统自带图标的内容普遍是 16~18pt，所以这里留一点呼吸；
// 1.1 → 图形长边 20px、短边约 16.4px，和旁边的电池 / Wi-Fi 一个视觉重量
const TRAY_MAC_MARGIN = 1.1;
const INK_ALPHA = 60;    // 高于这个 alpha 才算「真的有内容」（低于它多半是去背残留）
const MIN_ROW_RATIO = 0.004; // 一行/一列里至少要有这么多比例的像素有内容才算数
// 去背参数。设计稿的背景是「带噪点的浅灰」（不是纯色，也不是真透明），
// 而图形本身是高饱和蓝 / 深藏青，所以判据是「接近无彩 且 很亮」= 背景。
const SAT_TOL = 20;      // 饱和度低于它就往「无彩」靠
const SAT_RAMP = 12;     // 无彩判定过渡带
const BG_LUM = 120;      // 亮度高于它才开始算背景
const BG_RAMP = 30;      // 亮度过渡带（到 BG_LUM + BG_RAMP 就是纯背景）

// ---------------------------------------------------------------------------
// PNG 解码：只做这个脚本用得到的子集（非隔行，8/16 位，全部颜色类型）
// ---------------------------------------------------------------------------

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是 PNG 文件');
  }

  let pos = 8;
  let header = null;
  let palette = null;
  const idat = [];

  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    pos += 12 + length; // 长度 + 类型 + 数据 + CRC
  }

  if (!header) throw new Error('PNG 缺少 IHDR');
  if (header.interlace) throw new Error('不支持隔行扫描的 PNG');

  const { width, height, bitDepth, colorType } = header;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 PNG 颜色类型: ${colorType}`);
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`不支持的位深: ${bitDepth}`);

  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const lines = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line = lines.subarray(y * stride, (y + 1) * stride);
    raw.copy(line, 0, src, src + stride);
    src += stride;

    // 还原 PNG 的行滤镜（0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth）
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? line[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[i] = (line[i] + left) & 0xff; break;
        case 2: line[i] = (line[i] + up) & 0xff; break;
        case 3: line[i] = (line[i] + ((left + up) >> 1)) & 0xff; break;
        case 4: line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new Error(`未知的行滤镜: ${filter}`);
      }
    }
    prev = line;
  }

  // 统一展开成 RGBA8，后面的处理就只用一种像素布局
  const out = Buffer.alloc(width * height * 4);
  const scale = 1 / bytesPerSample;

  for (let i = 0, j = 0; i < width * height; i++, j += bpp) {
    const line = (i / width) | 0;
    const px = (i - line * width) * bpp;
    const base = line * stride + px;
    const o = i * 4;
    let r;
    let g;
    let b;
    let a = 255;

    if (colorType === 3) {
      const index = lines[base] * 3;
      r = palette ? palette[index] : 0;
      g = palette ? palette[index + 1] : 0;
      b = palette ? palette[index + 2] : 0;
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = lines[base];
      if (colorType === 4) a = lines[base + bytesPerSample];
    } else {
      r = lines[base];
      g = lines[base + bytesPerSample];
      b = lines[base + bytesPerSample * 2];
      if (colorType === 6) a = lines[base + bytesPerSample * 3];
    }

    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }

  return { width, height, data: out, hasAlpha: colorType === 4 || colorType === 6 };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---------------------------------------------------------------------------
// PNG 编码：RGBA8，逐行自适应选滤镜（文件能小一半），zlib 最高压缩
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  const candidate = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;

    let bestFilter = 0;
    let bestCost = Infinity;

    // 5 种滤镜都试一遍，取「绝对值之和」最小的——这是 libpng 的经典启发式
    for (let filter = 0; filter <= 4; filter++) {
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? row[i - 4] : 0;
        const up = prev ? prev[i] : 0;
        const upLeft = prev && i >= 4 ? prev[i - 4] : 0;
        let v;
        switch (filter) {
          case 0: v = row[i]; break;
          case 1: v = row[i] - left; break;
          case 2: v = row[i] - up; break;
          case 3: v = row[i] - ((left + up) >> 1); break;
          default: v = row[i] - paeth(left, up, upLeft); break;
        }
        v &= 0xff;
        candidate[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestFilter = filter;
        candidate.copy(best);
      }
    }

    raw[y * (stride + 1)] = bestFilter;
    best.copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 位深
  ihdr[9] = 6;  // 颜色类型 RGBA
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 非隔行

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 缩放：缩小走面积平均，放大走双线性；两者都按 alpha 预乘处理
// ---------------------------------------------------------------------------

function resample(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Buffer.from(src);
  return dw > sw || dh > sh
    ? resampleBilinear(src, sw, sh, dw, dh)
    : resampleBox(src, sw, sh, dw, dh);
}

/** 面积平均：每个目标像素取它覆盖到的所有源像素的加权平均 */
function resampleBox(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;

  for (let dy = 0; dy < dh; dy++) {
    const sy0 = dy * yRatio;
    const sy1 = sy0 + yRatio;
    const yStart = Math.floor(sy0);
    const yEnd = Math.ceil(sy1);

    for (let dx = 0; dx < dw; dx++) {
      const sx0 = dx * xRatio;
      const sx1 = sx0 + xRatio;
      const xStart = Math.floor(sx0);
      const xEnd = Math.ceil(sx1);

      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      let weight = 0;

      for (let sy = yStart; sy < yEnd; sy++) {
        const wy = Math.min(sy1, sy + 1) - Math.max(sy0, sy);
        if (wy <= 0) continue;
        const rowBase = sy * sw * 4;
        for (let sx = xStart; sx < xEnd; sx++) {
          const wx = Math.min(sx1, sx + 1) - Math.max(sx0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = rowBase + sx * 4;
          const a = src[i + 3] / 255;
          r += src[i] * a * w;
          g += src[i + 1] * a * w;
          b += src[i + 2] * a * w;
          alpha += src[i + 3] * w;
          weight += w;
        }
      }

      const o = (dy * dw + dx) * 4;
      const a = alpha / weight;              // 0~255
      if (a > 0) {
        // 预乘值除以 alpha 还原直通色；不还原的话边缘会偏黑
        const k = 255 / a;
        out[o] = Math.min(255, Math.round((r / weight) * k));
        out[o + 1] = Math.min(255, Math.round((g / weight) * k));
        out[o + 2] = Math.min(255, Math.round((b / weight) * k));
      }
      out[o + 3] = Math.round(a);
    }
  }

  return out;
}

/** 双线性：只在放大时用（源图比目标尺寸还小时） */
function resampleBilinear(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;

  const clampX = (x) => Math.min(sw - 1, Math.max(0, x));
  const clampY = (y) => Math.min(sh - 1, Math.max(0, y));

  for (let dy = 0; dy < dh; dy++) {
    const fy = Math.max(0, (dy + 0.5) * yRatio - 0.5);
    const y0 = Math.floor(fy);
    const ty = fy - y0;

    for (let dx = 0; dx < dw; dx++) {
      const fx = Math.max(0, (dx + 0.5) * xRatio - 0.5);
      const x0 = Math.floor(fx);
      const tx = fx - x0;

      const xa = clampX(x0);
      const xb = clampX(x0 + 1);
      const ya = clampY(y0);
      const yb = clampY(y0 + 1);

      const i00 = (ya * sw + xa) * 4;
      const i10 = (ya * sw + xb) * 4;
      const i01 = (yb * sw + xa) * 4;
      const i11 = (yb * sw + xb) * 4;

      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;

      // 先按 alpha 预乘做插值，再还原，边缘才不会发黑
      const a00 = src[i00 + 3] / 255;
      const a10 = src[i10 + 3] / 255;
      const a01 = src[i01 + 3] / 255;
      const a11 = src[i11 + 3] / 255;
      const pa = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;

      const o = (dy * dw + dx) * 4;
      if (pa > 0) {
        for (let c = 0; c < 3; c++) {
          const v = src[i00 + c] * a00 * w00 + src[i10 + c] * a10 * w10 +
            src[i01 + c] * a01 * w01 + src[i11 + c] * a11 * w11;
          out[o + c] = Math.min(255, Math.round(v / pa));
        }
      }
      out[o + 3] = Math.round(pa * 255);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// ICO 编码：32 位 BMP 条目（Windows 全版本都认，比 PNG 条目兼容性好）
// ---------------------------------------------------------------------------

function encodeIcoBmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);              // biSize
  header.writeInt32LE(size, 4);             // biWidth
  header.writeInt32LE(size * 2, 8);         // biHeight：XOR + AND 两张图
  header.writeUInt16LE(1, 12);              // biPlanes
  header.writeUInt16LE(32, 14);             // biBitCount
  header.writeUInt32LE(0, 16);              // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage

  // XOR 位图：BGRA，自下而上
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }

  // AND 掩码：1bpp，行按 4 字节对齐，全 0（透明度交给 alpha 通道）
  const maskStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskStride * size);

  return Buffer.concat([header, xor, and]);
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = [];
  const images = [];
  let offset = 6 + entries.length * 16;
  for (const entry of entries) {
    const image = encodeIcoBmpEntry(entry.size, entry.rgba);
    const item = Buffer.alloc(16);
    item.writeUInt8(entry.size >= 256 ? 0 : entry.size, 0);
    item.writeUInt8(entry.size >= 256 ? 0 : entry.size, 1);
    item.writeUInt8(0, 2);          // 调色板数量
    item.writeUInt8(0, 3);          // reserved
    item.writeUInt16LE(1, 4);       // planes
    item.writeUInt16LE(32, 6);      // bit count
    item.writeUInt32LE(image.length, 8);
    item.writeUInt32LE(offset, 12);
    offset += image.length;
    directory.push(item);
    images.push(image);
  }

  return Buffer.concat([header, ...directory, ...images]);
}

// ---------------------------------------------------------------------------
// 图像处理（原来是 Chromium 的 canvas 干的，现在都在这里）
// ---------------------------------------------------------------------------

/**
 * 按方框裁出一张正方形。方框允许超出源图边界——超出的部分就是透明的。
 * 早先这里把方框夹回图内，留边系数就白设了（见文件头「关键点二」）。
 */
function cropSquare(src, sw, sh, sx, sy, side) {
  const out = Buffer.alloc(side * side * 4);

  const x0 = Math.max(0, sx);
  const y0 = Math.max(0, sy);
  const x1 = Math.min(sw, sx + side);
  const y1 = Math.min(sh, sy + side);
  if (x1 <= x0 || y1 <= y0) return out;

  const width = x1 - x0;
  for (let y = y0; y < y1; y++) {
    const from = (y * sw + x0) * 4;
    const to = ((y - sy) * side + (x0 - sx)) * 4;
    src.copy(out, to, from, from + width * 4);
  }

  return out;
}

/** 按源矩形裁切后缩放到目标尺寸（README 的横版锁版用这个） */
function cropResize(src, sw, sh, sx, sy, cw, ch, dw, dh) {
  const cut = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const syy = sy + y;
    if (syy < 0 || syy >= sh) continue;
    const from = (syy * sw + sx) * 4;
    src.copy(cut, y * cw * 4, from, from + cw * 4);
  }
  return resample(cut, cw, ch, dw, dh);
}

function makeIcon() {
  const source = decodePng(fs.readFileSync(SOURCE));
  const W = source.width;
  const H = source.height;
  const px = source.data;

  // 0) 去背。
  //    设计稿导出时常常把「透明棋盘格」直接烤进像素里（这里就是：背景是 251/197 两种
  //    近白灰，alpha 全是 255），直接缩成图标会得到一个带格子的方块。
  //    这里按「接近无彩 + 很亮」判定为背景，并留一条渐变带，边缘不会出现硬锯齿。
  let keyed = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx - mn;                       // 0 = 完全无彩
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const neutral = Math.max(0, Math.min(1, (SAT_TOL - sat) / SAT_RAMP)); // 越无彩越像背景
    const light = Math.max(0, Math.min(1, (lum - BG_LUM) / BG_RAMP));
    const backgroundness = neutral * light;
    if (backgroundness > 0) {
      const a = Math.round(px[i + 3] * (1 - backgroundness));
      if (a !== px[i + 3]) keyed += 1;
      px[i + 3] = a;
    }
  }

  // 1) 每行统计「真的有内容」的像素数。
  //    注意不能只看「有没有一个透明像素」：细小的杂色噪点会让每一行都算有内容，
  //    图形和字标就切不开了。
  const MIN_ROW_INK = Math.max(2, Math.round(W * MIN_ROW_RATIO));
  const rowInk = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    const base = y * W * 4;
    let n = 0;
    for (let x = 0; x < W; x++) {
      if (px[base + x * 4 + 3] > INK_ALPHA) n += 1;
    }
    rowInk[y] = n;
  }

  // 2) 图形 / 字标的分界 = 下半部分第一段「足够长的连续空行」
  const GAP_ROWS = 8;
  let gapStart = -1;
  let runStart = -1;
  for (let y = Math.round(H * 0.3); y < H; y++) {
    if (rowInk[y] < MIN_ROW_INK) {
      if (runStart < 0) runStart = y;
      if (y - runStart + 1 >= GAP_ROWS) {
        gapStart = runStart;
        break;
      }
    } else {
      runStart = -1;
    }
  }

  let usedFallback = false;
  let markTop = 0;
  let markBottom = H - 1;
  if (gapStart > 0) {
    markBottom = gapStart - 1;
  } else {
    usedFallback = true;
    markBottom = Math.round(H * 0.62);
  }
  while (markBottom > 0 && rowInk[markBottom] < MIN_ROW_INK) markBottom -= 1;
  while (markTop < markBottom && rowInk[markTop] < MIN_ROW_INK) markTop += 1;

  // 3) 在图形这一段里求左右边界（按列统计，避免一两像素的杂色把边界撑开）
  const MIN_COL_INK = Math.max(2, Math.round((markBottom - markTop + 1) * MIN_ROW_RATIO));
  let left = -1;
  let right = -1;
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = markTop; y <= markBottom; y++) {
      if (px[(y * W + x) * 4 + 3] > INK_ALPHA) n += 1;
    }
    if (n >= MIN_COL_INK) {
      if (left < 0) left = x;
      right = x;
    }
  }
  if (right < 0) throw new Error('图形部分没有找到不透明像素');

  // 4) 只留「图形」这一块：正方形裁剪框在竖直方向必然会伸到字标里去
  //    （图标底部会露出 "Aihub" 的顶端），所以先把图形上下之外的内容清掉。
  const markW = right - left + 1;
  const markH = markBottom - markTop + 1;
  const cx = left + markW / 2;
  const cy = markTop + markH / 2;

  const markPixels = Buffer.from(px);
  for (let y = 0; y < H; y++) {
    if (y >= markTop && y <= markBottom) continue;
    markPixels.fill(0, y * W * 4, (y + 1) * W * 4);
  }

  // 5) 以图形中心为中心裁正方形，边长 = 图形长边 * 留边系数。
  //    方框可以比源图还大、可以越界，越出去的部分补透明（见文件头「关键点二」）。
  const squareAround = (margin) => {
    const side = Math.round(Math.max(markW, markH) * margin);
    const x = Math.round(cx - side / 2);
    const y = Math.round(cy - side / 2);
    return { side, x, y, data: cropSquare(markPixels, W, H, x, y, side) };
  };
  const iconSquare = squareAround(MARGIN);
  const traySquare = squareAround(TRAY_MARGIN);
  const trayMacSquare = squareAround(TRAY_MAC_MARGIN);

  // 6) README / 文档用的锁版（要带字标，所以从去背后的原图裁）
  const lockupW = Math.min(W, LOCKUP_MAX);
  const lockupH = Math.round((H - markTop) * (lockupW / W));
  const lockup = cropResize(px, W, H, 0, markTop, W, H - markTop, lockupW, lockupH);

  // 7) 托盘 / 菜单栏：从原分辨率的裁剪重采样，别拿 1024 那张硬缩，边缘会发灰。
  //    留边也比应用图标小得多——16~22px 的栏里图形要尽量占满，不然就是一小团看不清的东西。
  const square = (sq, size) => resample(sq.data, sq.side, sq.side, size, size);

  // 8) 图标额外要一份多分辨率的 ICO（BMP 条目，Windows 全版本都认）
  const ico = encodeIco(ICO_SIZES.map((size) => ({ size, rgba: square(iconSquare, size) })));

  return {
    source: { width: W, height: H, hasAlpha: source.hasAlpha },
    keyed,
    mark: { top: markTop, bottom: markBottom, left, right, width: markW, height: markH },
    crop: { x: iconSquare.x, y: iconSquare.y, side: iconSquare.side },
    trayCrop: { side: traySquare.side },
    trayMacCrop: { side: trayMacSquare.side },
    usedFallback,
    files: [
      ['build/icon.ico', ico],
      ['build/icon.png', encodePng(ICON_PNG, ICON_PNG, square(iconSquare, ICON_PNG))],
      ['build/tray.png', encodePng(TRAY_PNG, TRAY_PNG, square(traySquare, TRAY_PNG))],
      ['build/tray@2x.png', encodePng(TRAY_PNG * 2, TRAY_PNG * 2, square(traySquare, TRAY_PNG * 2))],
      ['build/tray-mac.png', encodePng(TRAY_MAC, TRAY_MAC, square(trayMacSquare, TRAY_MAC))],
      ['build/tray-mac@2x.png', encodePng(TRAY_MAC * 2, TRAY_MAC * 2, square(trayMacSquare, TRAY_MAC * 2))],
      ['assets/brand/logo.png', encodePng(lockupW, lockupH, lockup)],
      ['assets/brand/logo-mark.png', encodePng(MARK_PNG, MARK_PNG, square(iconSquare, MARK_PNG))],
    ],
  };
}

// ---------------------------------------------------------------------------

function writeIfChanged(rel, buffer) {
  const file = path.join(ROOT, rel);
  if (CHECK_ONLY) {
    const same = fs.existsSync(file) && fs.readFileSync(file).equals(buffer);
    return { file, rel, changed: !same, bytes: buffer.length };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return { file, rel, changed: true, bytes: buffer.length };
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    // 设计稿原图不进仓库（2 MB，只在本地用来生成素材），生成出来的图都已提交，
    // 所以克隆下来没有源图是正常的：跳过，不要让 CI 挂在这一步。
    console.log('没有设计稿源图（' + path.relative(ROOT, SOURCE).replace(/\\/g, '/') + '），跳过。');
    console.log('已提交的图标就是最终产物；需要重新生成时把原图放回该路径即可。');
    return;
  }

  const result = makeIcon();

  const results = [];
  for (const [rel, buffer] of result.files) {
    results.push(writeIfChanged(rel, buffer));
  }

  const mark = result.mark;
  console.log(`源图 ${result.source.width}x${result.source.height}，` +
    `去背处理了 ${result.keyed} 个像素`);
  console.log(`图形部分 ${mark.width}x${mark.height}（y ${mark.top}–${mark.bottom}）`);
  if (result.usedFallback) {
    console.log('  提示：图形和字标之间没有找到空行，按上 62% 估算的图形范围');
  }
  console.log(`裁成正方形 ${result.crop.side}x${result.crop.side}` +
    `（应用图标留边 ${MARGIN.toFixed(3)} 倍，图形占画布 ${(100 / MARGIN).toFixed(1)}%）`);
  console.log(`托盘裁剪 ${result.trayCrop.side}（Windows）/ ${result.trayMacCrop.side}（macOS 菜单栏）`);
  for (const item of results) {
    console.log(`  ${CHECK_ONLY && item.changed ? '✗ 需要重新生成 ' : '✓ '}${item.rel}  ${(item.bytes / 1024).toFixed(1)} KB`);
  }

  if (CHECK_ONLY && results.some((r) => r.changed)) {
    console.error('\n图标不是最新的，跑一次 npm run icon');
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error('生成图标失败:', err && err.message);
  process.exitCode = 1;
}
