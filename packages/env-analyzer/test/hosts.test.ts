import { describe, expect, test } from "bun:test";
import { hostMentions } from "../src/hosts";

describe("hostMentions", () => {
  test("finds a host with a port, after @ or //, and a whole-value name", () => {
    expect(hostMentions("postgres://app:pw@db:5432/app", "db")).toEqual([{ from: 18, host: "db", port: ":5432" }]);
    expect(hostMentions("http://api/health", "api")).toEqual([{ from: 7, host: "api", port: "" }]);
    expect(hostMentions("redis:6379", "redis")).toEqual([{ from: 0, host: "redis", port: ":6379" }]);
    expect(hostMentions("db", "db")).toEqual([{ from: 0, host: "db", port: "" }]);
    expect(hostMentions("a=db:1,b=DB:2", "db").map((m) => m.host)).toEqual(["db", "DB"]);
  });

  test("ignores the name inside other words and a bare name in a longer value", () => {
    expect(hostMentions("postgres", "post")).toEqual([]);
    expect(hostMentions("db_name", "db")).toEqual([]);
    expect(hostMentions("db and more", "db")).toEqual([]);
    expect(hostMentions("my-db:5432", "db")).toEqual([]);
    expect(hostMentions("anything", "")).toEqual([]);
  });
});
