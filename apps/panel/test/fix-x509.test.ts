// The panel's own certificates: written by hand in DER, so node:crypto and
// a real TLS handshake check them.

import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { issueCertificate, newKeyPair, spkiPin, toPem } from "../src/security/x509";

test("a self-signed server certificate parses, verifies and serves TLS", async () => {
  const keys = newKeyPair();
  const der = issueCertificate({
    commonName: "panel agents",
    publicKey: keys.publicKey,
    issuer: { commonName: "panel agents", privateKey: keys.privateKey },
    hosts: ["203.0.113.7", "2001:db8::7", "panel.internal", "127.0.0.1"],
    notAfter: new Date(Date.now() + 10 * 365 * 86_400_000),
  });
  const cert = new X509Certificate(toPem(der));
  expect(cert.verify(keys.publicKey)).toBe(true);
  expect(cert.checkIP("203.0.113.7")).toBe("203.0.113.7");
  expect(cert.checkHost("panel.internal")).toBe("panel.internal");
  expect(cert.subjectAltName).toContain("IP Address:2001:DB8:0:0:0:0:0:7");
  expect(spkiPin(cert.publicKey)).toBe(spkiPin(keys.publicKey));
  expect(spkiPin(keys.publicKey)).toMatch(/^sha256:[0-9a-f]{64}$/);

  const keyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: toPem(der), key: keyPem }, fetch: () => new Response("ok") });
  try {
    const res = await fetch(`https://127.0.0.1:${server.port}/`, { tls: { ca: toPem(der) } } as RequestInit);
    expect(await res.text()).toBe("ok");
  } finally {
    server.stop(true);
  }
});

test("a CA signs node certificates that verify against it", () => {
  const ca = newKeyPair();
  const caDer = issueCertificate({
    commonName: "LB CA",
    publicKey: ca.publicKey,
    issuer: { commonName: "LB CA", privateKey: ca.privateKey },
    ca: true,
    notAfter: new Date(Date.now() + 3650 * 86_400_000),
  });
  const node = newKeyPair();
  const leaf = new X509Certificate(
    toPem(
      issueCertificate({
        commonName: "lb.seylo.internal",
        publicKey: node.publicKey,
        issuer: { commonName: "LB CA", privateKey: ca.privateKey },
        hosts: ["lb.seylo.internal"],
        usages: ["serverAuth", "clientAuth"],
        notAfter: new Date(Date.now() + 365 * 86_400_000),
      }),
    ),
  );
  const caCert = new X509Certificate(toPem(caDer));
  expect(caCert.ca).toBe(true);
  expect(leaf.ca).toBe(false);
  expect(leaf.verify(caCert.publicKey)).toBe(true);
  expect(leaf.checkIssued(caCert)).toBe(true);
  expect(leaf.keyUsage).toEqual(expect.arrayContaining(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]));
});
