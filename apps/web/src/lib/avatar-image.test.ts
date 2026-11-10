import { describe, expect, test } from "bun:test";
import { avatarAccept, avatarFileProblem, centeredSquare } from "./avatar-image";

describe("avatarFileProblem", () => {
  test("takes PNG, JPEG and WebP", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) expect(avatarFileProblem({ type, size: 2_000_000 })).toBeNull();
    expect(avatarAccept).toBe("image/png,image/jpeg,image/webp");
  });

  test("refuses SVG and other types, and huge files before decoding them", () => {
    for (const type of ["image/svg+xml", "image/gif", "image/heic", "text/html", ""])
      expect(avatarFileProblem({ type, size: 10 })).toBe("type");
    expect(avatarFileProblem({ type: "image/jpeg", size: 30 * 1024 * 1024 })).toBe("tooBig");
  });
});

describe("centeredSquare", () => {
  test("cuts the middle of a wide or tall image", () => {
    expect(centeredSquare(400, 300)).toEqual({ x: 50, y: 0, size: 300 });
    expect(centeredSquare(300, 401)).toEqual({ x: 0, y: 50, size: 300 });
    expect(centeredSquare(256, 256)).toEqual({ x: 0, y: 0, size: 256 });
  });
});
