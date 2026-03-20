import http from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const port = Number(process.env.PORT || 3005);
const uiOrigin = new URL(process.env.UI_ORIGIN || "http://127.0.0.1:3105");
const runtimeOrigin = new URL(process.env.RUNTIME_ORIGIN || "http://127.0.0.1:8787");

function pickOrigin(pathname) {
  if (
    pathname === "/health" ||
    pathname.startsWith("/ops/") ||
    pathname.startsWith("/api/runtime/") ||
    pathname.startsWith("/v1/")
  ) {
    return runtimeOrigin;
  }

  return uiOrigin;
}

function proxyRequest(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const targetOrigin = pickOrigin(url.pathname);
  const targetUrl = new URL(url.pathname + url.search, targetOrigin);
  const doRequest = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;

  const upstream = doRequest(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.host,
        connection: "close"
      }
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "upstream_unavailable",
        message: error.message,
        target: targetUrl.origin
      })
    );
  });

  req.pipe(upstream);
}

const server = http.createServer(proxyRequest);

server.listen(port, "127.0.0.1", () => {
  console.log(
    `[one-app-proxy] listening on http://127.0.0.1:${port} -> ui=${uiOrigin.origin}, runtime=${runtimeOrigin.origin}`
  );
});
