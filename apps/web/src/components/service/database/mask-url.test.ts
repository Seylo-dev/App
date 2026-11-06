import { expect, test } from "bun:test";
import { maskUrlPassword } from "./mask-url";

test("only the password of a connection URL becomes dots", () => {
  expect(maskUrlPassword("postgres://postgres:Zq8vN3pXr7Lm2Kd9@db:5432/shop?sslmode=disable")).toBe(
    "postgres://postgres:••••••••••••••••@db:5432/shop?sslmode=disable",
  );
  expect(maskUrlPassword("redis://default:pw@redis:6379")).toBe("redis://default:••••••@redis:6379");
});

test("anything without a user and password is hidden whole", () => {
  expect(maskUrlPassword("not a url")).toBe("•••••••••");
});
