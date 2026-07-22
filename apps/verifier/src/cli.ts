import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { VerificationError } from "@sim/grading-core";
import { executeVerification } from "./adapter";

interface CliIo {
  out(line: string): void;
  error(line: string): void;
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export async function runVerifierCli(
  args: string[],
  io: CliIo = { out: (line) => console.log(line), error: (line) => console.error(line) },
): Promise<0 | 1> {
  const submissionPath = argument(args, "--submission");
  const gradingPath = argument(args, "--grading");
  const resultView = argument(args, "--view") ?? "student";
  if (!submissionPath || !gradingPath || (resultView !== "student" && resultView !== "instructor")) {
    io.error("Usage: verify --submission <submission.json> --grading <grading.json> [--view student|instructor]");
    return 1;
  }
  try {
    const [submissionText, gradingText] = await Promise.all([
      readFile(submissionPath, "utf8"),
      readFile(gradingPath, "utf8"),
    ]);
    const execution = executeVerification({
      submission: JSON.parse(submissionText) as unknown,
      gradingSpec: JSON.parse(gradingText) as unknown,
      resultView,
    });
    io.out(JSON.stringify(execution.result, null, 2));
    return 0;
  } catch (error) {
    const body = error instanceof VerificationError
      ? { error: { code: error.code, message: error.message, details: error.details } }
      : { error: { code: "verification-failed", message: error instanceof Error ? error.message : "Verification failed" } };
    io.error(JSON.stringify(body));
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runVerifierCli(process.argv.slice(2));
}
