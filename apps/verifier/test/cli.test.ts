import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runVerifierCli } from "../src/cli";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function run(submission = "submission.json") {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runVerifierCli(
    ["--submission", fixture(submission), "--grading", fixture("grading.json")],
    { out: (line) => output.push(line), error: (line) => errors.push(line) },
  );
  return { code, output, errors };
}

describe("verifier fixture CLI", () => {
  it("verifies a valid fixture and prints JSON", async () => {
    const execution = await run();
    expect(execution.code).toBe(0);
    expect(JSON.parse(execution.output[0]!)).toMatchObject({ status: "completed", score: 100 });
    expect(execution.errors).toEqual([]);
  });

  it("returns exit 1 for an invalid fixture", async () => {
    const execution = await run("invalid-submission.json");
    expect(execution.code).toBe(1);
    expect(JSON.parse(execution.errors[0]!)).toMatchObject({ error: { code: "invalid-submission" } });
  });

  it("prints stable JSON for identical fixtures", async () => {
    const first = await run();
    const second = await run();
    expect(first.output[0]).toBe(second.output[0]);
  });
});
