// Checks a registry login the way `docker login` does: GET /v2/, and when
// the registry asks for a bearer token, fetch one from its realm with the
// user name and password.

export interface RegistryLogin {
  server: string;
  username: string;
  password: string;
}

const timeoutMs = 15_000;

/** Docker Hub's API host for "docker.io" and its aliases. */
export function registryHost(server: string): string {
  const host = server.toLowerCase();
  return host === "docker.io" || host === "index.docker.io" || host === "registry.hub.docker.com" ? "registry-1.docker.io" : host;
}

function parseChallenge(header: string): { scheme: string; params: Record<string, string> } {
  const [scheme = "", ...rest] = header.trim().split(" ");
  const params: Record<string, string> = {};
  for (const m of rest.join(" ").matchAll(/(\w+)="([^"]*)"/g)) params[(m[1] as string).toLowerCase()] = m[2] as string;
  return { scheme: scheme.toLowerCase(), params };
}

/** null when the login works; otherwise the reason, safe to show. */
export async function checkRegistryLogin(login: RegistryLogin): Promise<string | null> {
  const basic = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString("base64")}`;
  const base = `https://${registryHost(login.server)}`;
  try {
    const probe = await fetch(`${base}/v2/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (probe.ok) return null;
    if (probe.status !== 401) return `The registry answered ${probe.status}.`;
    const challenge = parseChallenge(probe.headers.get("www-authenticate") ?? "");
    if (challenge.scheme === "basic") {
      const res = await fetch(`${base}/v2/`, { headers: { authorization: basic }, signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? null : res.status === 401 ? "The user name or password is wrong." : `The registry answered ${res.status}.`;
    }
    if (challenge.scheme === "bearer" && challenge.params.realm) {
      const url = new URL(challenge.params.realm);
      if (challenge.params.service) url.searchParams.set("service", challenge.params.service);
      const res = await fetch(url, { headers: { authorization: basic }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return null;
      return res.status === 401 || res.status === 403
        ? "The user name or password is wrong."
        : `The registry's login server answered ${res.status}.`;
    }
    return "The registry asked for a login method that is not supported.";
  } catch (error) {
    return `Could not reach ${login.server}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
