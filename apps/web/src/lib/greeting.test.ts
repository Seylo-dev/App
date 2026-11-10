import { expect, test } from "bun:test";
import { dayPart, firstName, greeting } from "./greeting";

test("the part of the day follows the hour on this device", () => {
  expect([5, 11, 12, 16, 17, 21, 22, 0, 4].map(dayPart)).toEqual([
    "morning",
    "morning",
    "afternoon",
    "afternoon",
    "evening",
    "evening",
    "night",
    "night",
    "night",
  ]);
});

test("the first name, or none: an email or a blank name is not one", () => {
  expect(firstName("Amir Eliz")).toBe("Amir");
  expect(firstName("  Lee  ")).toBe("Lee");
  expect(firstName("")).toBeNull();
  expect(firstName(null)).toBeNull();
});

test("greets by name and time, and without a name too", () => {
  expect(greeting("Amir Eliz", new Date(2026, 10, 10, 23, 30))).toBe("Good night, Amir 🌙");
  expect(greeting("Amir", new Date(2026, 10, 10, 8, 0))).toBe("Good morning, Amir ☀️");
  expect(greeting(null, new Date(2026, 10, 10, 18, 0))).toBe("Good evening 🌆");
});
