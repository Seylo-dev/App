// Tiny HTTP app for the Seylo e2e: answers with its version, the host name
// and the env values the checks look for.
const http = require("node:http");
const os = require("node:os");

const version = process.env.APP_VERSION || "v1";
const port = Number(process.env.PORT || 3000);

http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        app: "node-app",
        version,
        host: os.hostname(),
        greeting: process.env.GREETING || null,
        upstream: process.env.UPSTREAM_URL || null,
      }) + "\n",
    );
  })
  .listen(port, () => console.log(`node-app ${version} listening on ${port}`));
