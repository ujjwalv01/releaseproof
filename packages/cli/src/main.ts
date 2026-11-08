import { ExitCode } from "@releaseproof/core";
import { CommanderError } from "commander";
import { createProgram } from "./program.js";

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    // Commander already printed its diagnostic, help, or version.
    process.exitCode = error.exitCode === 0 ? ExitCode.Match : ExitCode.ToolError;
  } else {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = ExitCode.ToolError;
  }
}
