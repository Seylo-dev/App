// Comparing a database exposure's allow lists (databases.setExposure): an
// entry the old list does not hold lets clients in from new addresses, and
// a /0 (or ranges adding up to one) lets in every address of a family. Read
// the way the node's portgate reads them (netip.ParsePrefix): an entry's
// family is the one it is written in.

import { expect, test } from "bun:test";
import { allowListOpensAFamily, heldByAllowList } from "../src/http/ip-ranges";

test("an entry is held when one entry of the list covers its whole range", () => {
  expect(heldByAllowList("203.0.113.7/32", ["203.0.113.0/24"])).toBe(true);
  expect(heldByAllowList("203.0.113.7", ["203.0.113.7/32"])).toBe(true);
  expect(heldByAllowList("203.0.113.128/25", ["198.51.100.0/24", "203.0.113.0/24"])).toBe(true);
  // An entry written with host bits set still covers its prefix.
  expect(heldByAllowList("203.0.113.200/32", ["203.0.113.7/24"])).toBe(true);
  expect(heldByAllowList("2001:db8:1::5/128", ["2001:db8::/32"])).toBe(true);
  expect(heldByAllowList("0.0.0.0/0", ["0.0.0.0/0"])).toBe(true);
});

test("a wider range, another range, another family or a catch-all is not held", () => {
  expect(heldByAllowList("203.0.113.0/24", ["203.0.113.7/32"])).toBe(false);
  expect(heldByAllowList("198.51.100.9/32", ["203.0.113.7/32"])).toBe(false);
  expect(heldByAllowList("0.0.0.0/0", ["203.0.113.7/32"])).toBe(false);
  expect(heldByAllowList("0.0.0.0/1", ["203.0.113.7/32"])).toBe(false);
  expect(heldByAllowList("::/0", ["0.0.0.0/0"])).toBe(false);
  expect(heldByAllowList("0.0.0.0/0", ["::/0"])).toBe(false);
  // IPv4-mapped IPv6 stays IPv6, as on the node.
  expect(heldByAllowList("::ffff:203.0.113.7/128", ["203.0.113.0/24"])).toBe(false);
  // Split across two entries: asked about, never let through unasked.
  expect(heldByAllowList("10.0.0.0/24", ["10.0.0.0/25", "10.0.0.128/25"])).toBe(false);
  // An empty list holds nothing; what it means is the caller's.
  expect(heldByAllowList("203.0.113.7/32", [])).toBe(false);
  expect(heldByAllowList("not an address", ["0.0.0.0/0"])).toBe(false);
  expect(heldByAllowList("203.0.113.7/32", ["not an address"])).toBe(false);
});

test("a /0, or ranges adding up to one, opens a whole family", () => {
  expect(allowListOpensAFamily(["0.0.0.0/0"])).toBe(true);
  expect(allowListOpensAFamily(["::/0"])).toBe(true);
  expect(allowListOpensAFamily(["203.0.113.7/32", "0.0.0.0/0"])).toBe(true);
  expect(allowListOpensAFamily(["0.0.0.0/1", "128.0.0.0/1"])).toBe(true);
  // In any order, overlapping, written with host bits.
  expect(allowListOpensAFamily(["128.0.0.0/1", "64.0.0.0/2", "0.0.0.0/2", "10.0.0.0/8"])).toBe(true);
  expect(allowListOpensAFamily(["1.2.3.4/1", "200.0.0.0/1"])).toBe(true);
  expect(allowListOpensAFamily(["8000::/1", "::/1"])).toBe(true);
});

test("a list with a gap anywhere, or halves of two families, opens none", () => {
  expect(allowListOpensAFamily([])).toBe(false);
  expect(allowListOpensAFamily(["203.0.113.7/32"])).toBe(false);
  expect(allowListOpensAFamily(["0.0.0.0/1"])).toBe(false);
  expect(allowListOpensAFamily(["0.0.0.0/1", "128.0.0.0/2"])).toBe(false);
  expect(allowListOpensAFamily(["0.0.0.0/2", "128.0.0.0/1"])).toBe(false);
  expect(allowListOpensAFamily(["0.0.0.0/1", "8000::/1"])).toBe(false);
  expect(allowListOpensAFamily(["::ffff:0.0.0.0/96"])).toBe(false);
  expect(allowListOpensAFamily(["not an address"])).toBe(false);
});
