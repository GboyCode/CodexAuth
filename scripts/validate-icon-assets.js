const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function validateIco(filename) {
  const bytes = fs.readFileSync(filename);
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  assert.equal(bytes.readUInt16LE(4), 7, "all supported icon sizes must be present");
  const dimensions = [];
  for (let index = 0; index < 7; index++) {
    const entry = 6 + index * 16;
    const size = bytes[entry] || 256;
    assert.equal(bytes[entry + 1] || 256, size, "icon must be square");
    dimensions.push(size);
    const length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
    assert.ok(offset >= 118 && offset + length <= bytes.length, "complete icon frame");
    const dib = bytes.subarray(offset, offset + length);
    assert.equal(dib.readUInt32LE(0), 40);
    assert.equal(dib.readInt32LE(4), size);
    assert.equal(dib.readInt32LE(8), size * 2);
    assert.equal(dib.readUInt16LE(14), 32);
    assert.equal(length, 40 + size * size * 4 + Math.ceil(size / 32) * 4 * size);
    if (size < 64) continue;
    // The white horizontal face stroke belongs near the center, not at the
    // bottom. The cropped v0.1.36 CI icons put it around 82% of the image height.
    const rows = [];
    for (let y = Math.floor(size * 0.4); y < size * 0.85; y++) {
      let white = 0;
      for (let x = Math.floor(size * 0.43); x < size * 0.57; x++) {
        const pixel = 40 + ((size - 1 - y) * size + x) * 4;
        if ([0, 1, 2, 3].every(channel => dib[pixel + channel] >= 235)) white++;
      }
      if (white >= size * 0.1) rows.push(y);
    }
    assert.ok(rows.length, `${path.basename(filename)} ${size}px: missing face stroke`);
    const center = rows.reduce((sum, y) => sum + y, 0) / rows.length / size;
    assert.ok(center >= 0.5 && center <= 0.65, `${path.basename(filename)} ${size}px: distorted icon (face height ${center.toFixed(3)})`);
  }
  assert.deepEqual(dimensions.sort((left, right) => left - right), [16, 24, 32, 48, 64, 128, 256]);
}

function validateAssets(directory) {
  const png = fs.readFileSync(path.join(directory, "codex-color.png"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  for (const name of ["codex-color.ico", "codex-color-tray.ico"]) validateIco(path.join(directory, name));
}

module.exports = { validateIco, validateAssets };
if (require.main === module) {
  validateAssets(path.resolve(__dirname, "../src/ui/assets"));
  console.log("Icon assets passed: 1024px PNG, all 7 ICO sizes, complete frames and undistorted face placement.");
}
