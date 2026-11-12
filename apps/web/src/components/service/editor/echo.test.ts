import { describe, expect, test } from "bun:test";
import { EchoTracker } from "./echo";

describe("CodeEditor echoes", () => {
  // Typing THIRD=3 fast: the editor reports every key, React renders with an older text.
  test("an old text the editor reported is an echo, not a reload", () => {
    const echo = new EchoTracker();
    for (const text of ["T", "TH", "THI", "THIR", "THIRD", "THIRD=", "THIRD=3"]) echo.emitted(text);
    expect(echo.isEcho("THI")).toBe(true);
    // The renders that follow hand in newer texts, also echoes.
    expect(echo.isEcho("THIRD=")).toBe(true);
    expect(echo.isEcho("THIRD=3")).toBe(true);
  });

  test("a text the editor never reported is a reload, also one it reported before the last echo", () => {
    const echo = new EchoTracker();
    echo.emitted("A=1");
    echo.emitted("A=12");
    expect(echo.isEcho("A=12")).toBe(true);
    // Load their version: someone else's text.
    expect(echo.isEcho("B=2")).toBe(false);
    // A reload back to an older text of this editor still applies.
    expect(echo.isEcho("A=1")).toBe(false);
  });

  test("it keeps a bounded number of texts", () => {
    const echo = new EchoTracker();
    for (let i = 0; i < 500; i++) echo.emitted(`X=${i}`);
    expect(echo.isEcho("X=0")).toBe(false);
    expect(echo.isEcho("X=499")).toBe(true);
  });
});
