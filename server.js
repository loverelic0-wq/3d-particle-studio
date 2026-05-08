import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(".");
const port = Number(process.env.PORT || 5173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".obj": "text/plain; charset=utf-8"
};

createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  let filePath = resolve(join(root, safePath || "index.html"));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }

  if (!existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": types[extname(filePath)] || "application/octet-stream",
    "Cross-Origin-Opener-Policy": "same-origin"
  });
  createReadStream(filePath).pipe(response);
}).listen(port, () => {
  console.log(`3D particle studio running at http://localhost:${port}`);
});
