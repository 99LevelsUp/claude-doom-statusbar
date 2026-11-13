// Minimal PNG decoder on the built-in zlib, enough for the face sprites: 8-bit greyscale, grey+alpha,
// RGB, RGBA and palette images, no interlace. Returns { width, height, rgba } with 4 bytes per pixel.
import { inflateSync } from "node:zlib";

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let o = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), tag = buf.toString("latin1", o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (tag === "IHDR") { width = d.readUInt32BE(0); height = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (tag === "PLTE") palette = d;
    else if (tag === "tRNS") trns = d;
    else if (tag === "IDAT") idat.push(d);
    else if (tag === "IEND") break;
    o += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0, b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch, t = i * 4;
    if (type === 6) { rgba[t] = px[s]; rgba[t + 1] = px[s + 1]; rgba[t + 2] = px[s + 2]; rgba[t + 3] = px[s + 3]; }
    else if (type === 2) { rgba[t] = px[s]; rgba[t + 1] = px[s + 1]; rgba[t + 2] = px[s + 2]; rgba[t + 3] = 255; }
    else if (type === 0) { rgba[t] = rgba[t + 1] = rgba[t + 2] = px[s]; rgba[t + 3] = 255; }
    else if (type === 4) { rgba[t] = rgba[t + 1] = rgba[t + 2] = px[s]; rgba[t + 3] = px[s + 1]; }
    else { const p = px[s]; rgba[t] = palette[p * 3]; rgba[t + 1] = palette[p * 3 + 1]; rgba[t + 2] = palette[p * 3 + 2]; rgba[t + 3] = trns && p < trns.length ? trns[p] : 255; }
  }
  return { width, height, rgba };
}
