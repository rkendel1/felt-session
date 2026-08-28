import { describe, expect, test } from "bun:test";
import { extractSetupToken, redactSetupOutput } from "./claude-setup-login";

describe("Claude in-app setup-token capture", () => {
  test("extracts a setup token through terminal color escapes", () => {
    const token = `sk-ant-oat01-${"a".repeat(64)}`;
    expect(extractSetupToken(`\x1b[32m${token}\x1b[0m\r\n`)).toBe(token);
  });

  test("never returns a captured token in public error output", () => {
    const token = `sk-ant-oat01-${"b".repeat(64)}`;
    const output = redactSetupOutput(`Failed after printing ${token}`);
    expect(output).not.toContain(token);
    expect(output).toContain("[redacted]");
  });
});
