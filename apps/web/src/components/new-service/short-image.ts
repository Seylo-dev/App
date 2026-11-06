// The version picker shows each version's image next to it. Tags are short;
// a digest pin (KeyDB publishes no multi-arch version tag) is 85 characters,
// so it shows shortened, with the full reference in the title.

/** "eqalpha/keydb@sha256:6537505c4235..." (64 hex) -> "eqalpha/keydb@sha256:6537505c4235…"; tags unchanged. */
export function shortImage(image: string): string {
  const match = /^(.+@sha256:)([0-9a-f]{12})[0-9a-f]{52}$/.exec(image);
  return match ? `${match[1]}${match[2]}…` : image;
}
