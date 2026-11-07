// Small WebSocket client for the e2e checks (console, shell, logs follow).
// Prints text frames as lines prefixed "T " and binary frames as "B " plus
// the bytes as text, for the given number of seconds, then exits 0. Exits 2
// when the socket fails to open.
//
// Usage: bun wsclient.ts <ws-url> [--seconds N] [--wait-for TEXT]
//          [--send-binary TEXT]... [--send-text JSON]... [--send-after-ready]
// Sends happen once the socket opens (or after the first "ready" text frame
// with --send-after-ready); \n in TEXT is a newline, \r a carriage return
// (what a terminal sends for Enter; line editors such as valkey-cli's take
// only that).

const args = process.argv.slice(2);
const url = args.shift();
if (!url) {
  console.error("usage: bun wsclient.ts <ws-url> [options]");
  process.exit(2);
}
let seconds = 10;
let waitFor: string | null = null;
let afterReady = false;
const sends: { binary: boolean; data: string }[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1] ?? "";
  if (a === "--seconds") (seconds = Number(v)), i++;
  else if (a === "--wait-for") (waitFor = v), i++;
  else if (a === "--send-binary") sends.push({ binary: true, data: v.replaceAll("\\n", "\n").replaceAll("\\r", "\r") }), i++;
  else if (a === "--send-text") sends.push({ binary: false, data: v }), i++;
  else if (a === "--send-after-ready") afterReady = true;
}

let seen = "";
let sent = false;
const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
const sendAll = () => {
  if (sent) return;
  sent = true;
  for (const s of sends) ws.send(s.binary ? new TextEncoder().encode(s.data) : s.data);
};
ws.onopen = () => {
  console.log("OPEN");
  if (!afterReady) setTimeout(sendAll, 300);
};
ws.onmessage = (event) => {
  let line: string;
  if (typeof event.data === "string") {
    line = `T ${event.data}`;
    if (afterReady && event.data.includes('"ready"')) setTimeout(sendAll, 300);
  } else {
    line = `B ${new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer))}`;
  }
  console.log(line);
  seen += line;
  if (waitFor && seen.includes(waitFor)) {
    console.log("FOUND");
    ws.close();
    process.exit(0);
  }
};
ws.onerror = () => {
  console.log("ERROR");
};
ws.onclose = (event) => {
  console.log(`CLOSE ${event.code} ${event.reason}`);
  process.exit(waitFor ? 1 : 0);
};
setTimeout(() => {
  ws.close();
  process.exit(waitFor ? 1 : 0);
}, seconds * 1000);
