const zlib = require('zlib');

// ---------- Minimal PNG encoder (no external dependencies) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Build scanlines (each prefixed with filter byte 0)
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const idat = zlib.deflateSync(raw);
  const iend = Buffer.alloc(0);

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', iend)]);
}

// ------------------------------------------------------------------
// Draw a "touch strip" style icon: dark rounded square, glowing strip
// ------------------------------------------------------------------
function createIconPNG(size = 256) {
  const pixels = Buffer.alloc(size * size * 4);

  // Rounded-rect mask for background
  const radius = size * 0.18;
  const bgGrad = [
    [22, 26, 32], // top
    [12, 14, 18]  // bottom
  ];

  // Strip colors
  const stripColors = [
    [255, 179, 71],  // amber
    [255, 99, 71],   // vivid red-orange
    [120, 180, 255], // sky blue
    [140, 220, 150]  // green
  ];

  const stripY1 = size * 0.62;
  const stripY2 = size * 0.78;
  const stripMargin = size * 0.12;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Rounded-square mask
      const dx = Math.max(Math.abs(x - size / 2) - (size / 2 - radius), 0);
      const dy = Math.max(Math.abs(y - size / 2) - (size / 2 - radius), 0);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const inside = radius - dist;
      let alpha = Math.min(Math.max(inside + 0.5, 0), 1);
      if (alpha <= 0) {
        pixels[idx + 3] = 0;
        continue;
      }

      // Vertical background gradient
      const t = y / size;
      let r = Math.round(bgGrad[0][0] * (1 - t) + bgGrad[1][0] * t);
      let g = Math.round(bgGrad[0][1] * (1 - t) + bgGrad[1][1] * t);
      let b = Math.round(bgGrad[0][2] * (1 - t) + bgGrad[1][2] * t);

      // Strip area: horizontal gradient across the color blocks
      if (y >= stripY1 && y <= stripY2 && x >= stripMargin && x <= size - stripMargin) {
        const rel = (x - stripMargin) / (size - 2 * stripMargin);
        const pos = rel * (stripColors.length - 1);
        const i = Math.min(Math.floor(pos), stripColors.length - 2);
        const f = pos - i;
        const c1 = stripColors[i];
        const c2 = stripColors[Math.min(i + 1, stripColors.length - 1)];

        r = Math.round(c1[0] * (1 - f) + c2[0] * f);
        g = Math.round(c1[1] * (1 - f) + c2[1] * f);
        b = Math.round(c1[2] * (1 - f) + c2[2] * f);

        // Rounded ends for the strip
        const corner = size * 0.06;
        // Simple roundness: alpha fade at the left/right edges
        const edge = Math.min(x - stripMargin, size - stripMargin - x);
        if (edge < corner) {
          const edgeFade = edge / corner;
          alpha *= edgeFade;
        }

        // Subtle vertical shading on the strip
        const vShade = 0.85 + 0.15 * ((y - stripY1) / (stripY2 - stripY1));
        r = Math.round(r * vShade);
        g = Math.round(g * vShade);
        b = Math.round(b * vShade);
      }

      // Anti-alias edge
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = Math.round(alpha * 255);
    }
  }

  return encodePNG(size, size, pixels);
}

module.exports = { createIconPNG };