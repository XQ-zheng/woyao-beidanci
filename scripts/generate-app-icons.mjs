#!/usr/bin/env node
/**
 * 生成「我要背单词」的应用图标（PNG + 多尺寸 ICO）。
 *
 * 为什么要自己画：仓库里没有任何位图资源，而窗口图标、托盘、任务栏、快捷方式
 * 都要求真实存在的图标文件；缺了它 Windows 会显示成一张白纸（或 Electron 默认图标）。
 *
 * 设计：圆角方形底 + 靛蓝→紫的对角渐变 + 两片白色“翻开的单词卡”。
 * 全部是几何图形、不含文字，所以永远不会出现字体缺失导致的乱码方块；
 * 两片卡片在小尺寸下依然有清晰的明暗对比，16px 也认得出。
 *
 * 实现刻意零依赖：
 * - 图形用有向距离场（SDF）光栅化，边缘天然抗锯齿，不需要 canvas 原生模块；
 * - PNG 自己写 zlib 流，ICO 自己拼 BMP 目录（16~128 用 32 位 BMP，256 用 PNG）。
 *
 * 用法：`npm run icons`（或 `node scripts/generate-app-icons.mjs [--out-dir 目录]`）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

/** 仓库根目录（`scripts/` 的上一级）。 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** 主画布边长：先按 1024 光栅化，再盒式降采样到各尺寸。 */
const CANVAS = 1024;

/** ICO 内含的尺寸（Windows 资源管理器/任务栏/Alt-Tab 各取所需）。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 圆角方形底：圆角半径占画布比例。 */
const BACKGROUND_RADIUS = 224;

/** 渐变色标（对角方向，从左上到右下）。 */
const GRADIENT_STOPS = [
  { at: 0, rgb: [79, 70, 229] }, // indigo-600 #4F46E5
  { at: 0.55, rgb: [124, 58, 237] }, // violet-600 #7C3AED
  { at: 1, rgb: [168, 85, 247] }, // purple-500 #A855F7
];

/**
 * 两页“翻开的单词卡”。
 *
 * 每页是一个四边形：外侧边更长、内侧（书脊）边更短，上下两条边都朝中间收，
 * 中缝留 ~56px 的渐变缝当书脊。这是“打开的书”最经典也最抗缩放的剪影
 * （正着看像一个横向的 ><），而不是两根竖条或一顶房子。
 * 右页 `alpha` 略低，两页不会糊成一整块白。
 *
 * 注意圆角是“内缩”出来的（见 createRoundedPolygonSdf），所以多边形顶点要比
 * 想要的实际边界再外扩一个 radius；中缝宽度的算式是 (右内边 - 左内边) + 2 * radius。
 */
const PAGES = [
  {
    points: [
      { x: 150, y: 306 }, // 外侧上
      { x: 505, y: 350 }, // 内侧上（书脊，略低）
      { x: 505, y: 674 }, // 内侧下
      { x: 150, y: 718 }, // 外侧下
    ],
    radius: 30,
    alpha: 1,
  },
  {
    points: [
      { x: 874, y: 306 },
      { x: 501, y: 350 },
      { x: 501, y: 674 },
      { x: 874, y: 718 },
    ],
    radius: 30,
    alpha: 0.94,
  },
];

/**
 * 命令行参数解析（只支持 `--out-dir <目录>` 与 `--preview <png 路径>`）。
 *
 * @param {readonly string[]} argv 进程参数（不含 node 与脚本名）。
 * @returns {{outDir: string, previewPath: string | null}} 输出目录与可选预览图路径。
 */
function parseArgs(argv) {
  let outDir = path.join(repoRoot, 'apps', 'electron', 'assets');
  let previewPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out-dir' && argv[index + 1] !== undefined) {
      outDir = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argv[index] === '--preview' && argv[index + 1] !== undefined) {
      previewPath = path.resolve(argv[index + 1]);
      index += 1;
    }
  }
  return { outDir, previewPath };
}

/**
 * 圆角矩形有向距离场（负数在内部）。
 *
 * @param {number} px 采样点 x。
 * @param {number} py 采样点 y。
 * @param {number} cx 中心 x。
 * @param {number} cy 中心 y。
 * @param {number} halfWidth 半宽。
 * @param {number} halfHeight 半高。
 * @param {number} radius 圆角半径。
 * @returns {number} 到边界的距离（像素）。
 */
function roundedRectSdf(px, py, cx, cy, halfWidth, halfHeight, radius) {
  const dx = Math.abs(px - cx) - (halfWidth - radius);
  const dy = Math.abs(py - cy) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

/**
 * 由距离场得到像素覆盖率（1px 过渡带，近似 1 像素宽的抗锯齿）。
 *
 * @param {number} distance SDF 值。
 * @returns {number} 0~1 的覆盖率。
 */
function coverageOf(distance) {
  return Math.min(1, Math.max(0, 0.5 - distance));
}

/**
 * 给凸四边形做一个“内缩圆角”的有向距离场。
 *
 * 做法：凸多边形的 SDF 等于所有边的**最大**半平面距离；把半径减掉相当于整体内缩，
 * 于是四个尖角自然变成圆角，而且边缘依然可以用 {@link coverageOf} 做抗锯齿。
 *
 * @param {ReadonlyArray<{x: number, y: number}>} points 顶点（顺序即可，正反都能处理）。
 * @param {number} radius 圆角半径（同时也是向内缩进的量）。
 * @returns {(px: number, py: number) => number} SDF 求值函数。
 */
function createRoundedPolygonSdf(points, radius) {
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length;

  const planes = points.map((start, index) => {
    const end = points[(index + 1) % points.length];
    const edgeX = end.x - start.x;
    const edgeY = end.y - start.y;
    const length = Math.hypot(edgeX, edgeY);
    let normalX = edgeY / length;
    let normalY = -edgeX / length;
    // 让法线朝外：形心必须落在负半空间。
    if (normalX * (centerX - start.x) + normalY * (centerY - start.y) > 0) {
      normalX = -normalX;
      normalY = -normalY;
    }
    return { normalX, normalY, startX: start.x, startY: start.y };
  });

  return (px, py) => {
    let distance = -Infinity;
    for (const plane of planes) {
      const value = plane.normalX * (px - plane.startX) + plane.normalY * (py - plane.startY);
      if (value > distance) {
        distance = value;
      }
    }
    // 加半径 = 整体内缩：尖角被“磨圆”，四条边各自向内让出 radius。
    return distance + radius;
  };
}

/**
 * 取对角渐变色。
 *
 * @param {number} t 0~1 的插值位置。
 * @returns {[number, number, number]} RGB。
 */
function gradientAt(t) {
  const clamped = Math.min(1, Math.max(0, t));
  for (let index = 1; index < GRADIENT_STOPS.length; index += 1) {
    const left = GRADIENT_STOPS[index - 1];
    const right = GRADIENT_STOPS[index];
    if (clamped <= right.at) {
      const span = right.at - left.at;
      const local = span === 0 ? 0 : (clamped - left.at) / span;
      return [
        left.rgb[0] + (right.rgb[0] - left.rgb[0]) * local,
        left.rgb[1] + (right.rgb[1] - left.rgb[1]) * local,
        left.rgb[2] + (right.rgb[2] - left.rgb[2]) * local,
      ];
    }
  }
  const last = GRADIENT_STOPS[GRADIENT_STOPS.length - 1];
  return [...last.rgb];
}

/**
 * 把 (r,g,b,a) 以 source-over 方式叠到目标像素上（全部用 0~1 浮点，避免反复取整）。
 *
 * @param {number[]} pixel 目标像素 [r,g,b,a]。
 * @param {number} r 源红。
 * @param {number} g 源绿。
 * @param {number} b 源蓝。
 * @param {number} a 源透明度。
 */
function blendOver(pixel, r, g, b, a) {
  if (a <= 0) {
    return;
  }
  const dstA = pixel[3];
  const outA = a + dstA * (1 - a);
  if (outA <= 0) {
    pixel[0] = 0;
    pixel[1] = 0;
    pixel[2] = 0;
    pixel[3] = 0;
    return;
  }
  pixel[0] = (r * a + pixel[0] * dstA * (1 - a)) / outA;
  pixel[1] = (g * a + pixel[1] * dstA * (1 - a)) / outA;
  pixel[2] = (b * a + pixel[2] * dstA * (1 - a)) / outA;
  pixel[3] = outA;
}

/**
 * 渲染 1024×1024 的 RGBA 画布。
 *
 * @returns {Uint8ClampedArray} 长度 1024*1024*4 的像素数据（非预乘）。
 */
function renderMaster() {
  const pixels = new Uint8ClampedArray(CANVAS * CANVAS * 4);
  const center = CANVAS / 2;
  const pageSdfs = PAGES.map((page) => createRoundedPolygonSdf(page.points, page.radius));

  for (let y = 0; y < CANVAS; y += 1) {
    for (let x = 0; x < CANVAS; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const pixel = [0, 0, 0, 0];

      // 1) 圆角方形底 + 对角渐变。
      const backgroundDistance = roundedRectSdf(px, py, center, center, center, center, BACKGROUND_RADIUS);
      const backgroundCoverage = coverageOf(backgroundDistance);
      if (backgroundCoverage > 0) {
        const [r, g, b] = gradientAt((px + py) / (CANVAS * 2));
        // 左上角一点柔光：让纯色块看起来有材质，而不是一张贴纸。
        const highlight = 0.12 * Math.exp(-Math.hypot(px - CANVAS * 0.22, py - CANVAS * 0.18) / 420);
        blendOver(
          pixel,
          r + (255 - r) * highlight,
          g + (255 - g) * highlight,
          b + (255 - b) * highlight,
          backgroundCoverage,
        );
      }

      // 2) 两页白色书页。
      for (let index = 0; index < PAGES.length; index += 1) {
        const pageCoverage = coverageOf(pageSdfs[index](px, py));
        if (pageCoverage > 0) {
          blendOver(pixel, 255, 255, 255, pageCoverage * PAGES[index].alpha * backgroundCoverage);
        }
      }

      const offset = (y * CANVAS + x) * 4;
      pixels[offset] = Math.round(pixel[0]);
      pixels[offset + 1] = Math.round(pixel[1]);
      pixels[offset + 2] = Math.round(pixel[2]);
      pixels[offset + 3] = Math.round(pixel[3] * 255);
    }
  }
  return pixels;
}

/**
 * 盒式降采样（1024 → size）。按预乘 alpha 加权平均，避免半透明边缘发灰。
 *
 * 缩放比例不一定是整数（例如 1024/24 ≈ 42.67），所以每个目标像素按“源矩形与像素的
 * 重叠面积”加权，而不是简单地取整数块——否则 24px 这类尺寸会带一层斜边噪点。
 *
 * @param {Uint8ClampedArray} source 母版像素。
 * @param {number} size 目标边长。
 * @returns {Uint8Array} size*size*4 的 RGBA 像素。
 */
function downsample(source, size) {
  const factor = CANVAS / size;
  const target = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    const sourceTop = y * factor;
    const sourceBottom = sourceTop + factor;
    const firstRow = Math.floor(sourceTop);
    const lastRow = Math.min(CANVAS - 1, Math.ceil(sourceBottom) - 1);
    for (let x = 0; x < size; x += 1) {
      const sourceLeft = x * factor;
      const sourceRight = sourceLeft + factor;
      const firstColumn = Math.floor(sourceLeft);
      const lastColumn = Math.min(CANVAS - 1, Math.ceil(sourceRight) - 1);

      let r = 0;
      let g = 0;
      let b = 0;
      let alphaSum = 0;
      let weightSum = 0;
      for (let sy = firstRow; sy <= lastRow; sy += 1) {
        const rowWeight = Math.min(sourceBottom, sy + 1) - Math.max(sourceTop, sy);
        if (rowWeight <= 0) {
          continue;
        }
        for (let sx = firstColumn; sx <= lastColumn; sx += 1) {
          const columnWeight = Math.min(sourceRight, sx + 1) - Math.max(sourceLeft, sx);
          if (columnWeight <= 0) {
            continue;
          }
          const weight = rowWeight * columnWeight;
          const offset = (sy * CANVAS + sx) * 4;
          const alpha = source[offset + 3] / 255;
          r += source[offset] * alpha * weight;
          g += source[offset + 1] * alpha * weight;
          b += source[offset + 2] * alpha * weight;
          alphaSum += alpha * weight;
          weightSum += weight;
        }
      }

      const offset = (y * size + x) * 4;
      if (alphaSum === 0 || weightSum === 0) {
        continue;
      }
      target[offset] = Math.round(r / alphaSum);
      target[offset + 1] = Math.round(g / alphaSum);
      target[offset + 2] = Math.round(b / alphaSum);
      target[offset + 3] = Math.round((alphaSum / weightSum) * 255);
    }
  }
  return target;
}

/** CRC32 查表（PNG 每个 chunk 都要）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32。
 *
 * @param {Buffer} buffer 输入。
 * @returns {number} 校验值。
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 组装一个 PNG chunk。
 *
 * @param {string} type 四个 ASCII 字符的类型。
 * @param {Buffer} data 负载。
 * @returns {Buffer} 完整 chunk。
 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * 把 RGBA 像素编码成 PNG（8 位 RGBA、无滤波）。
 *
 * @param {Uint8Array} rgba width*height*4 像素。
 * @param {number} width 宽度。
 * @param {number} height 高度（省略时按正方形处理）。
 * @returns {Buffer} PNG 文件内容。
 */
function encodePng(rgba, width, height = width) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0（None）
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 把 RGBA 像素编码成 ICO 里的 32 位 BMP（BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码）。
 *
 * 小尺寸用 BMP 而不是 PNG：老一点的 shell 组件（部分右键菜单、旧版任务栏）只认 BMP。
 *
 * @param {Uint8Array} rgba size*size*4 像素。
 * @param {number} size 边长。
 * @returns {Buffer} BMP 负载（不含 ICO 目录项）。
 */
function encodeBmpIcon(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight = XOR + AND
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceRow = size - 1 - y; // BMP 自下而上
    for (let x = 0; x < size; x += 1) {
      const source = (sourceRow * size + x) * 4;
      const target = (y * size + x) * 4;
      xor[target] = rgba[source + 2]; // B
      xor[target + 1] = rgba[source + 1]; // G
      xor[target + 2] = rgba[source]; // R
      xor[target + 3] = rgba[source + 3]; // A
    }
  }

  // AND 掩码：32bpp 下 Windows 用 alpha 通道，掩码全 0 即可，但必须存在且按 4 字节对齐。
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size, 0);

  return Buffer.concat([header, xor, mask]);
}

/**
 * 组装 ICO 文件。
 *
 * @param {ReadonlyArray<{size: number, data: Buffer, format: 'png' | 'bmp'}>} images 各尺寸数据。
 * @returns {Buffer} ICO 文件内容。
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  const payloads = [];
  let offset = 6 + images.length * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size; // 0 代表 256
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0; // 调色板颜色数
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(image.data);
    offset += image.data.length;
  }

  return Buffer.concat([header, ...entries, ...payloads]);
}

/**
 * 生成“各尺寸并排”的预览图，方便肉眼验收小尺寸是否还认得出。
 *
 * 每个尺寸都用最近邻放大到 128px 见方，背景是浅灰——接近资源管理器/任务栏的观感。
 *
 * @param {string} target 预览图输出路径。
 * @param {ReadonlyMap<number, Uint8Array>} rendered 各尺寸像素。
 */
function writePreview(target, rendered) {
  const sizes = [16, 24, 32, 48, 64, 128];
  const cell = 128;
  const padding = 12;
  const width = sizes.length * cell + padding * (sizes.length + 1);
  const height = cell + padding * 2;
  // 浅灰底（240）不透明，便于观察透明边缘是否发灰。
  const canvas = new Uint8Array(width * height * 4).fill(240);
  for (let index = 3; index < canvas.length; index += 4) {
    canvas[index] = 255;
  }

  sizes.forEach((size, slot) => {
    const rgba = rendered.get(size);
    const originX = padding + slot * (cell + padding);
    const scale = Math.floor(cell / size);
    const drawn = size * scale;
    const originY = padding + Math.floor((cell - drawn) / 2);
    for (let y = 0; y < drawn; y += 1) {
      for (let x = 0; x < drawn; x += 1) {
        const source = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
        const alpha = rgba[source + 3] / 255;
        const targetOffset = ((originY + y) * width + originX + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          canvas[targetOffset + channel] = Math.round(
            rgba[source + channel] * alpha + canvas[targetOffset + channel] * (1 - alpha),
          );
        }
      }
    }
  });

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, encodePng(canvas, width, height));
  console.log(`[icons] 预览（16/24/32/48/64/128）：${target}`);
}

/**
 * 入口。
 */
function main() {
  const { outDir, previewPath } = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });

  const startedAt = Date.now();
  const master = renderMaster();
  const rendered = new Map(ICO_SIZES.map((size) => [size, downsample(master, size)]));

  const pngPath = path.join(outDir, 'icon.png');
  // 窗口/托盘图标直接用母版（1024×1024），高 DPI 屏上不会糊。
  const png = encodePng(master, CANVAS);
  writeFileSync(pngPath, png);

  const icoImages = ICO_SIZES.map((size) => {
    const rgba = rendered.get(size);
    return {
      size,
      format: size >= 256 ? 'png' : 'bmp',
      data: size >= 256 ? encodePng(rgba, size) : encodeBmpIcon(rgba, size),
    };
  });
  const icoPath = path.join(outDir, 'icon.ico');
  writeFileSync(icoPath, encodeIco(icoImages));

  console.log(`[icons] ${pngPath} (${CANVAS}x${CANVAS}, ${png.length} B)`);
  console.log(
    `[icons] ${icoPath} (${ICO_SIZES.join('/')}, ${icoImages.reduce((sum, image) => sum + image.data.length, 0)} B)`,
  );
  if (previewPath !== null) {
    writePreview(previewPath, rendered);
  }
  console.log(`[icons] 完成，用时 ${Date.now() - startedAt} ms`);
}

main();
