const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, nativeImage } = require("electron");

const sizes = [16, 24, 32, 48, 64, 128, 256];

app.on("window-all-closed", () => {});

function iconEntrySize(size) {
  return size >= 256 ? 0 : size;
}

function buildDib(size, bitmap) {
  if (bitmap.length !== size * size * 4) {
    throw new Error(`Icon bitmap must be exactly ${size} x ${size} pixels.`);
  }
  const header = Buffer.alloc(40);
  const pixels = Buffer.alloc(size * size * 4);
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);

  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(pixels.length, 20);

  for (let y = 0; y < size; y += 1) {
    const targetStart = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const sourceIndex = (y * size + x) * 4;
      const targetIndex = targetStart + x * 4;
      const alpha = bitmap[sourceIndex + 3];
      pixels[targetIndex] = unpremultiply(bitmap[sourceIndex], alpha);
      pixels[targetIndex + 1] = unpremultiply(bitmap[sourceIndex + 1], alpha);
      pixels[targetIndex + 2] = unpremultiply(bitmap[sourceIndex + 2], alpha);
      pixels[targetIndex + 3] = alpha;
    }
  }

  return Buffer.concat([header, pixels, mask]);
}

function unpremultiply(channel, alpha) {
  if (alpha === 0 || alpha === 255) return channel;
  return Math.max(0, Math.min(255, Math.round((channel * 255) / alpha)));
}

function buildIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  const header = Buffer.alloc(headerSize + images.length * entrySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entryOffset = headerSize + index * entrySize;
    header.writeUInt8(iconEntrySize(size), entryOffset);
    header.writeUInt8(iconEntrySize(size), entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(data.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += data.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

async function renderSvg(source, size, padding = 0) {
  return renderIcon(source, size, { padding });
}

async function renderTaskbarIcon(foregroundSource, size) {
  return renderIcon(foregroundSource, size, { taskbar: true });
}

async function renderIcon(foregroundSource, size, { padding = 0, taskbar = false } = {}) {
  const svg = await fs.readFile(foregroundSource, "utf8");
  // Canvas dimensions are independent of the window, display size and DPI.
  // capturePage() can silently crop a large window to a CI runner's work area.
  const win = new BrowserWindow({
    width: 128,
    height: 128,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
    },
  });
  try {
    await win.loadURL("data:text/html;charset=utf-8,<!doctype html><meta charset=utf-8>");
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const size = ${JSON.stringify(size)};
      const image = new Image();
      image.src = ${JSON.stringify(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)};
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      if (${JSON.stringify(taskbar)}) {
        context.fillStyle = "white";
        context.beginPath();
        context.roundRect(0, 0, size, size, size * 0.23);
        context.fill();
      }
      const inset = ${JSON.stringify(taskbar ? -size * 0.08 : padding)};
      context.drawImage(image, inset, inset, size - inset * 2, size - inset * 2);
      return canvas.toDataURL("image/png");
    })()`);
    const image = nativeImage.createFromDataURL(dataUrl);
    const dimensions = image.getSize();
    if (image.isEmpty() || dimensions.width !== size || dimensions.height !== size) {
      throw new Error(`Icon rendering failed: expected ${size} x ${size} pixels.`);
    }
    return image;
  } finally {
    win.destroy();
  }
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const appSource = path.join(root, "src", "ui", "assets", "codex-color.svg");
  const trayIconSource = path.join(root, "src", "ui", "assets", "codex-color-no-bg.svg");
  const pngTarget = path.join(root, "src", "ui", "assets", "codex-color.png");
  const iconTarget = path.join(root, "src", "ui", "assets", "codex-color.ico");
  const trayIconTarget = path.join(root, "src", "ui", "assets", "codex-color-tray.ico");
  const image = await renderSvg(appSource, 1024);
  if (image.isEmpty()) {
    throw new Error(`Unable to read app icon source: ${appSource}`);
  }

  await fs.writeFile(pngTarget, image.resize({ width: 1024, height: 1024, quality: "best" }).toPNG());
  const taskbarIconImage = await renderTaskbarIcon(trayIconSource, 1024);
  if (taskbarIconImage.isEmpty()) {
    throw new Error(`Unable to compose taskbar icon source: ${trayIconSource}`);
  }
  const trayIconImage = await renderSvg(trayIconSource, 1024);
  if (trayIconImage.isEmpty()) {
    throw new Error(`Unable to read tray icon source: ${trayIconSource}`);
  }
  const whiteIconImages = [];
  const trayIconImages = [];
  for (const size of sizes) {
    const whiteRendered =
      size <= 48
        ? (await renderTaskbarIcon(trayIconSource, size * 4)).resize({
            width: size,
            height: size,
            quality: "best",
          })
        : taskbarIconImage.resize({ width: size, height: size, quality: "best" });
    whiteIconImages.push({
      size,
      data: buildDib(size, whiteRendered.toBitmap()),
    });

    const rendered =
      size <= 48
        ? (await renderSvg(trayIconSource, size * 4, 0)).resize({
            width: size,
            height: size,
            quality: "best",
          })
        : trayIconImage.resize({ width: size, height: size, quality: "best" });
    trayIconImages.push({
      size,
      data: buildDib(size, rendered.toBitmap()),
    });
  }
  await fs.writeFile(iconTarget, buildIco(whiteIconImages));
  await fs.writeFile(trayIconTarget, buildIco(trayIconImages));
  console.log(
    `Wrote ${path.relative(root, pngTarget)}, ${path.relative(root, iconTarget)}, and ${path.relative(
      root,
      trayIconTarget
    )}.`
  );
}

module.exports = { renderSvg, renderTaskbarIcon, buildDib, buildIco };

// Electron loads its entry script through its bootstrap rather than require.main.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) app.whenReady()
  .then(main)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
