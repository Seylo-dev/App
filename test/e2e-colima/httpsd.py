# HTTPS server for the e2e: static files from <directory>, and smart-HTTP git
# (git http-backend as CGI) for the bare repositories under <directory>/git.
# The panel only accepts https:// git URLs and the agent clones shallow
# (dumb HTTP cannot), so serve.sh runs this next to the plain HTTP release
# server, with a certificate from a test-only CA (dist/e2e/state/tls).
#
# Usage: python3 -I httpsd.py <bind> <port> <directory> <cert> <key>
import functools
import http.server
import os
import ssl
import subprocess
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith("/git/"):
            self.git()
        else:
            super().do_GET()

    def do_POST(self) -> None:
        if self.path.startswith("/git/"):
            self.git()
        else:
            self.send_error(405)

    def git(self) -> None:
        path, _, query = self.path.partition("?")
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        env = {
            "GIT_PROJECT_ROOT": os.path.join(self.directory, "git"),
            "GIT_HTTP_EXPORT_ALL": "1",
            "PATH_INFO": path[len("/git"):],
            "QUERY_STRING": query,
            "REQUEST_METHOD": self.command,
            "CONTENT_TYPE": self.headers.get("content-type", ""),
            "CONTENT_LENGTH": str(len(body)),
            "REMOTE_ADDR": self.client_address[0],
            "GIT_PROTOCOL": self.headers.get("git-protocol", ""),
            "HTTP_CONTENT_ENCODING": self.headers.get("content-encoding", ""),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        }
        proc = subprocess.run(["git", "http-backend"], input=body, env=env, capture_output=True)
        head, _, payload = proc.stdout.partition(b"\r\n\r\n")
        if not _:
            head, _, payload = proc.stdout.partition(b"\n\n")
        status = 200
        headers = []
        for line in head.decode("latin-1").splitlines():
            name, _, value = line.partition(":")
            if name.lower() == "status":
                status = int(value.strip().split()[0])
            elif name:
                headers.append((name, value.strip()))
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    bind, port, directory, cert, key = sys.argv[1:6]
    handler = functools.partial(Handler, directory=directory)
    server = http.server.ThreadingHTTPServer((bind, int(port)), handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
