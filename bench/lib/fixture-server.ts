/**
 * The fixture app's HTTP server — plain `node:http`, no framework dependency. Serves the
 * static page in `bench/fixture-app/index.html` and one endpoint that always 500s, so the
 * browser smoke check (`bench/lib/browser-smoke.ts`) and any future live-model run have real,
 * deterministic defects to find.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, "..", "fixture-app", "index.html"), "utf-8");

export interface FixtureServerHandle {
  server: http.Server;
  /** `host:port`, for `BrowserSession`'s `allowedHost`. */
  host: string;
  /** Full base URL to navigate to. */
  url: string;
  close: () => Promise<void>;
}

export function startFixtureServer(): Promise<FixtureServerHandle> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/api/data") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("seeded failure — this endpoint always 500s");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const host = `127.0.0.1:${port}`;
      resolve({
        server,
        host,
        url: `http://${host}/`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
