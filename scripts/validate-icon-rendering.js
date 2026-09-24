const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app, screen } = require("electron");
const { renderSvg, renderTaskbarIcon, buildDib, buildIco } = require("./generate-icon");
const { validateIco } = require("./validate-icon-assets");

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-icon-test-"));
  try {
    const fixture = path.join(root, "corners.svg");
    await fs.writeFile(fixture, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path fill="red" d="M0 0h50v50H0z"/><path fill="lime" d="M50 0h50v50H50z"/><path fill="blue" d="M0 50h50v50H0z"/><path fill="yellow" d="M50 50h50v50H50z"/></svg>');
    const image = await renderSvg(fixture, 1024);
    assert.deepEqual(image.getSize(), { width: 1024, height: 1024 });
    const bitmap = image.toBitmap();
    for (const [x, y, expected] of [[20, 20, [0, 0, 255, 255]], [1000, 20, [0, 255, 0, 255]],
      [20, 1000, [255, 0, 0, 255]], [1000, 1000, [0, 255, 255, 255]], [500, 500, [0, 0, 255, 255]], [520, 520, [0, 255, 255, 255]]]) {
      assert.deepEqual([...bitmap.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4)], expected, "corners and center boundaries must survive the small render window without cropping/stretching");
    }
    const foreground = path.resolve(__dirname, "../src/ui/assets/codex-color-no-bg.svg");
    for (const [name, render] of [["app", renderTaskbarIcon], ["tray", renderSvg]]) {
      const rendered = await render(foreground, 1024);
      const frames = [16, 24, 32, 48, 64, 128, 256].map(size => ({ size,
        data: buildDib(size, rendered.resize({ width: size, height: size, quality: "best" }).toBitmap()) }));
      const icon = path.join(root, `${name}.ico`);
      await fs.writeFile(icon, buildIco(frames));
      validateIco(icon);
    }
    assert.throws(() => buildDib(64, Buffer.alloc(64 * 32 * 4)), /exactly/);
    console.log(`Icon rendering passed: full 1024px canvas inside a 128px window, edge/center pixel checks and all app/tray ICO sizes (display scale ${screen.getPrimaryDisplay().scaleFactor}).`);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codexauth-icon-test-"));
    await fs.rm(root, { recursive: true, force: true });
  }
}

app.whenReady().then(run).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => app.quit());
