import { describe, expect, test } from "bun:test";
import { parseEnv, setEnvVariable } from "../src";

const set = (text: string, key: string, value: string | null) => {
  const edit = setEnvVariable(text, key, value);
  if (!edit.ok) throw new Error(edit.message);
  return edit.text;
};

describe("setEnvVariable", () => {
  test("replaces the last line with the key and nothing else", () => {
    const text = "# api\nAPI_URL=https://old.example.com\nOTHER=1\nAPI_URL=https://api.example.com # the one that wins\n";
    expect(set(text, "API_URL", "${{api.URL}}/v1")).toBe(
      "# api\nAPI_URL=https://old.example.com\nOTHER=1\nAPI_URL=${{api.URL}}/v1 # the one that wins\n",
    );
  });

  test("keeps export, the comments above (# @public included) and the trailing comment", () => {
    const text = "# The browser reads this\n# @public\nexport  NEXT_PUBLIC_API = https://api.example.com   # keep\nB=2";
    expect(set(text, "NEXT_PUBLIC_API", "${{api.URL}}")).toBe(
      "# The browser reads this\n# @public\nexport  NEXT_PUBLIC_API = ${{api.URL}}   # keep\nB=2",
    );
  });

  test("keeps the quote style when the value fits it, else double quotes", () => {
    expect(set('A="old value" # c\n', "A", "new value")).toBe('A="new value" # c\n');
    expect(set('A="old"\n', "A", 'say "hi"\\')).toBe('A="say \\"hi\\"\\\\"\n');
    expect(set("A='old'\n", "A", "raw $HOME")).toBe("A='raw $HOME'\n");
    // Single quotes take no references and no single quote: double quotes then.
    expect(set("A='old'\n", "A", "${{api.URL}}")).toBe('A="${{api.URL}}"\n');
    expect(set("A='old'\n", "A", "it's")).toBe('A="it\'s"\n');
    expect(set("A=`old`\n", "A", "${{api.URL}}")).toBe("A=`${{api.URL}}`\n");
    expect(set("A=old\n", "A", "two words")).toBe('A="two words"\n');
    expect(set("A=old\n", "A", "")).toBe("A=\n");
    expect(set("A= # note\n", "A", "x")).toBe("A= x # note\n");
    // A multi-line value is replaced whole.
    expect(set('A="one\ntwo" # c\nB=2\n', "A", "x")).toBe('A="x" # c\nB=2\n');
  });

  test("a value with a newline is written in quotes and reads back the same", () => {
    const text = set("A=1\n", "PEM", "-----BEGIN KEY-----\nabc\n-----END KEY-----");
    expect(text).toBe('A=1\nPEM="-----BEGIN KEY-----\\nabc\\n-----END KEY-----"\n');
    expect(parseEnv(text).entries.at(-1)?.value).toBe("-----BEGIN KEY-----\nabc\n-----END KEY-----");
    // A newline cannot add a line of its own.
    const sneaky = set("A=1\n", "B", "x\nINJECTED=1");
    expect(parseEnv(sneaky).entries.map((e) => e.key)).toEqual(["A", "B"]);
  });

  test("appends a new key at the end, after a missing final newline", () => {
    expect(set("", "A", "1")).toBe("A=1\n");
    expect(set("B=2", "A", "1")).toBe("B=2\nA=1\n");
    expect(set("B=2\r\n", "A", "1")).toBe("B=2\r\nA=1\r\n");
  });

  test("null removes every line with the key, and a # @public or # @secret line right above one", () => {
    const text = "# Stripe\n# @secret\nSTRIPE=sk_test_x\nB=2\nSTRIPE=again # trailing\n# notes stay\nC=3";
    expect(set(text, "STRIPE", null)).toBe("# Stripe\nB=2\n# notes stay\nC=3");
    expect(set("A=1", "A", null)).toBe("");
  });

  test("refusals name the key, never the value", () => {
    expect(setEnvVariable("A=1\n", "1BAD", "x")).toMatchObject({ ok: false, reason: "invalid-key" });
    expect(setEnvVariable("A=1\n", "BAD KEY", "x")).toMatchObject({ ok: false, reason: "invalid-key" });
    expect(setEnvVariable("A=1\n", "B", null)).toMatchObject({ ok: false, reason: "not-set" });
    const broken = setEnvVariable("A=1\n", "B", "token-123 ${{api.URL");
    expect(broken).toMatchObject({ ok: false, reason: "invalid-value" });
    expect(!broken.ok && broken.message).toBe("The value of B: Reference is missing its closing }}.");
  });
});
