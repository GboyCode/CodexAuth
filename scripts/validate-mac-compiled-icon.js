const assert = require("node:assert/strict");
const fs = require("node:fs");
const { app, nativeImage } = require("electron");

function pixels(filename) {
  const image = nativeImage.createFromBuffer(fs.readFileSync(filename));
  assert.ok(!image.isEmpty(), `Unreadable icon: ${filename}`);
  const { width, height } = image.getSize();
  assert.equal(width, height);
  assert.ok(width >= 512, "inspect a full-resolution compiled icon");
  return { data: image.toBitmap(), width, height };
}
function dark(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  // nativeImage bitmaps use premultiplied alpha. A translucent white tile edge
  // must not be mistaken for a dark part of the foreground silhouette.
  return frame.data[i + 3] >= 192 && frame.data[i] + frame.data[i + 1] + frame.data[i + 2] < 600 * frame.data[i + 3] / 255;
}
function white(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return frame.data[i + 3] >= 192 && [0, 1, 2].every(c => frame.data[i + c] > 210 * frame.data[i + 3] / 255);
}
function bounds(frame) {
  let left = frame.width, right = -1, top = frame.height, bottom = -1;
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    if (!dark(frame, x, y)) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  assert.ok(right - left > frame.width * .5 && bottom - top > frame.height * .5, "missing or undersized glyph");
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}
function compare(master, actual) {
  const a = bounds(master), b = bounds(actual);
  assert.ok(Math.abs(a.width / a.height - b.width / b.height) < .04,
    `compiled glyph is clipped or distorted: source ${a.width}x${a.height}, compiled ${b.width}x${b.height}`);
  let intersection = 0, union = 0;
  const face = [{ total: 0, matching: 0 }, { total: 0, matching: 0 }, { total: 0, matching: 0 }];
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const ax = a.left + Math.floor((x + .5) * a.width / 256), ay = a.top + Math.floor((y + .5) * a.height / 256);
    const bx = b.left + Math.floor((x + .5) * b.width / 256), by = b.top + Math.floor((y + .5) * b.height / 256);
    const expected = dark(master, ax, ay), got = dark(actual, bx, by);
    if (expected || got) union++;
    if (expected && got) intersection++;
    // Check each eye and the mouth separately: a missing eye is too small
    // to reliably detect from overall silhouette similarity alone.
    if (white(master, ax, ay)) {
      const part = face[x < 95 ? 0 : x > 160 ? 2 : 1];
      part.total++;
      // Native glass edges and ICNS antialiasing can move a stroke boundary by
      // a few pixels. Match a small neighborhood without accepting a lost eye.
      const radius = Math.max(1, Math.round(b.width / 128));
      if ([-radius, 0, radius].some(dy => [-radius, 0, radius].some(dx =>
        white(actual, Math.max(0, Math.min(actual.width - 1, bx + dx)),
          Math.max(0, Math.min(actual.height - 1, by + dy)))))) part.matching++;
    }
  }
  const similarity = intersection / union;
  assert.ok(similarity >= .95, `compiled icon lost artwork: similarity ${similarity.toFixed(4)}`);
  face.forEach((part, i) => {
    assert.ok(part.total > 30, `master face component ${i} is missing`);
    assert.ok(part.matching / part.total >= .9,
      `compiled face component ${i} is missing or distorted: ${(part.matching / part.total * 100).toFixed(2)}% matched`);
  });
  return similarity;
}

app.whenReady().then(() => {
  const [masterFile, ...compiledFiles] = process.argv.slice(2);
  assert.ok(masterFile && compiledFiles.length);
  const master = pixels(masterFile);
  // Regression fixtures for the reported missing lobe and missing left eye.
  const clipped = { ...master, data: Buffer.from(master.data) };
  const missingEye = { ...master, data: Buffer.from(master.data) };
  for (let y = 0; y < master.height; y++) for (let x = 0; x < master.width * .4; x++) {
    const i = (y * master.width + x) * 4;
    if (x < master.width * .25) clipped.data[i + 3] = 0;
    if (white(master, x, y)) missingEye.data.fill(64, i, i + 3);
  }
  assert.throws(() => compare(master, clipped), /clipped|lost artwork/);
  assert.throws(() => compare(master, missingEye), /face component 0/);
  for (const file of compiledFiles) console.log(`Compiled icon verified: ${file}, silhouette ${(compare(master, pixels(file)) * 100).toFixed(2)}%, both eyes and mouth intact.`);
}).then(() => app.quit(), error => { console.error(error); app.exit(1); });
