// Passkey sign-in in the browser. The panel sends WebAuthn options as JSON
// (base64url for binary fields) and wants the credential back as JSON.
// Browsers with the JSON helpers (parseRequestOptionsFromJSON, toJSON) use
// them; older ones get the same conversion by hand.

type Json = Record<string, unknown>;

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

export async function getPasskeyAssertion(options: Json): Promise<Json> {
  const publicKey = parseRequestOptions(options);
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was chosen.");
  return credentialToJson(credential);
}

function parseRequestOptions(options: Json): PublicKeyCredentialRequestOptions {
  const helper = (PublicKeyCredential as unknown as { parseRequestOptionsFromJSON?: (json: Json) => PublicKeyCredentialRequestOptions })
    .parseRequestOptionsFromJSON;
  if (helper) return helper(options);
  const allow = (options.allowCredentials as { id: string; type: string; transports?: string[] }[] | undefined) ?? [];
  return {
    ...(options as object),
    challenge: fromBase64Url(String(options.challenge)),
    allowCredentials: allow.map((item) => ({ ...item, id: fromBase64Url(item.id), type: "public-key" as const })),
  } as PublicKeyCredentialRequestOptions;
}

function credentialToJson(credential: PublicKeyCredential): Json {
  const own = (credential as unknown as { toJSON?: () => Json }).toJSON;
  if (own) return own.call(credential);
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined,
    },
  };
}

export function fromBase64Url(value: string): ArrayBuffer {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function toBase64Url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
