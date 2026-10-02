import http from "node:http";
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSite } from "../site/build.mjs";

// Only generated public files are served, never source or desktop account data.
const built = await buildSite({ preview: true });
const root = await realpath(built.outputDirectory);
const port = Number(process.env.SITE_PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("SITE_PORT must be an integer between 1 and 65535.");
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
const server = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    return response.end();
  }
  try {
    const url = new URL(request.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    if (["/zh", "/en"].includes(pathname)) {
      response.writeHead(301, { Location: `${pathname}/${url.search}` });
      return response.end();
    }
    const file = path.resolve(
      root,
      `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`,
    );
    const relative = path.relative(root, file);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative
        .split(path.sep)
        .some((part) => part.startsWith("_") || part.startsWith("."))
    ) {
      response.writeHead(404);
      return response.end("Not found");
    }
    const actual = await realpath(file);
    const resolvedRelative = path.relative(root, actual);
    if (
      resolvedRelative.startsWith("..") ||
      path.isAbsolute(resolvedRelative)
    ) {
      response.writeHead(404);
      return response.end("Not found");
    }
    const body = await readFile(actual);
    response.writeHead(200, {
      "Content-Type": types[path.extname(actual)] || "application/octet-stream",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    const malformed =
      error instanceof URIError || error.code === "ERR_INVALID_URL";
    response.writeHead(malformed ? 400 : 404, {
      "Content-Type": "text/html; charset=utf-8",
    });
    response.end(
      request.method === "HEAD"
        ? undefined
        : malformed
          ? "Bad request"
          : await readFile(path.join(root, "404.html")),
    );
  }
});
let rebuildTimer;
let building = false;
let dirty = false;
async function rebuild() {
  if (building) { dirty = true; return; }
  building = true;
  try {
    await buildSite({ preview: true });
    console.log("Website rebuilt. Refresh the browser to see changes.");
  } catch (error) {
    console.error(`Website rebuild failed: ${error.message}`);
  } finally {
    building = false;
    if (dirty) { dirty = false; void rebuild(); }
  }
}
const watcher = watch(fileURLToPath(new URL("../site/", import.meta.url)), { recursive: true }, (_event, name) => {
  if (!name || /^(dist|node_modules)([\\/]|$)/.test(name)) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 120);
});
server.on("error", (error) => {
  watcher.close();
  console.error(`Site preview could not start: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    `CodexAuth website: http://127.0.0.1:${port}\nPublic directory: ${root}\nSources rebuild automatically; refresh the browser after editing. Press Ctrl+C to stop.`,
  );
});
