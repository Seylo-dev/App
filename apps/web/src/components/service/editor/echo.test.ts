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

  // A shared env sheet open, nobody typing: the text goes A -> B -> C -> B as others save. Each
  // reload fires the editor's change event, which reports its text; recorded as an echo, the
  // revert to B was skipped and the editor kept showing C while the parent held B.
  test("a reload's own report is no echo: a later reload back to that text applies", () => {
    const echo = new EchoTracker();
    // What the editor would do with a value prop that is not an echo: apply it as a reload,
    // and the edit reports it through onChange.
    const render = (value: string) => {
      if (echo.isEcho(value)) return false;
      echo.reload(() => echo.emitted(value));
      return true;
    };
    expect(render("B")).toBe(true);
    expect(render("C")).toBe(true);
    expect(render("B")).toBe(true);
  });

  test("what was typed before a reload is no echo after it", () => {
    const echo = new EchoTracker();
    echo.emitted("A=1");
    echo.emitted("A=12");
    echo.reload(() => echo.emitted("B=2"));
    expect(echo.isEcho("A=12")).toBe(false);
    expect(echo.isEcho("B=2")).toBe(false);
    // Typing after it is tracked again.
    echo.emitted("B=23");
    expect(echo.isEcho("B=23")).toBe(true);
    // A failing apply still ends the reload.
    expect(() =>
      echo.reload(() => {
        throw new Error("no model");
      }),
    ).toThrow("no model");
    echo.emitted("C=3");
    expect(echo.isEcho("C=3")).toBe(true);
  });

  test("it keeps a bounded number of texts", () => {
    const echo = new EchoTracker();
    for (let i = 0; i < 500; i++) echo.emitted(`X=${i}`);
    expect(echo.isEcho("X=0")).toBe(false);
    expect(echo.isEcho("X=499")).toBe(true);
  });
});
