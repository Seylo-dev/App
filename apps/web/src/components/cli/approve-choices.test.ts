import { expect, test } from "bun:test";
import { addressDiffers, approveInput, type Choices, initialChoices } from "./approve-choices";

const code = "ABCD-EFGH";

test("nothing is approvable before the person picks access and projects", () => {
  const choices = initialChoices();
  expect(choices.access).toBeNull();
  expect(choices.projectMode).toBeNull();
  expect(approveInput(code, choices)).toBeNull();
  expect(approveInput(code, { ...choices, access: "full" })).toBeNull();
  expect(approveInput(code, { ...choices, projectMode: "all" })).toBeNull();
});

test("the default lifetime is the shortest choice", () => {
  expect(initialChoices().days).toBe(7);
});

test("the input follows the choices", () => {
  const base: Choices = { ...initialChoices(), access: "readOnly", projectMode: "all" };
  expect(approveInput(code, base)).toEqual({ userCode: code, readOnly: true, expiresInDays: 7 });
  expect(approveInput(code, { ...base, access: "full", days: 30 })).toEqual({ userCode: code, readOnly: false, expiresInDays: 30 });
});

test("some projects needs at least one project", () => {
  const some: Choices = { ...initialChoices(), access: "full", projectMode: "some" };
  expect(approveInput(code, some)).toBeNull();
  expect(approveInput(code, { ...some, projectIds: new Set(["p1", "p2"]) })).toEqual({
    userCode: code,
    readOnly: false,
    expiresInDays: 7,
    projectIds: ["p1", "p2"],
  });
});

test("addresses are compared without the IPv4-mapped prefix", () => {
  expect(addressDiffers("203.0.113.5", "203.0.113.5")).toBe(false);
  expect(addressDiffers("::ffff:203.0.113.5", "203.0.113.5")).toBe(false);
  expect(addressDiffers("2001:DB8::1", "2001:db8::1")).toBe(false);
  expect(addressDiffers("203.0.113.5", "198.51.100.24")).toBe(true);
});

test("an unknown address is not a difference", () => {
  expect(addressDiffers(null, "203.0.113.5")).toBe(false);
  expect(addressDiffers("203.0.113.5", null)).toBe(false);
});
