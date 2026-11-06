// Password hashing with argon2id (Bun.password, which also picks the salt
// and encodes the parameters into the hash).

// Verified against when the email is unknown, so a wrong email costs as much
// time as a wrong password and response timing does not reveal accounts.
let dummyHash: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword("not-a-real-password");
    await Bun.password.verify(password, await dummyHash);
    return false;
  }
  return Bun.password.verify(password, hash);
}
