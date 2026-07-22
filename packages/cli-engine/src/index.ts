// Session + factory
export { CliSession, createCliSession } from "./session/session";
export { type CliMode, promptSuffix } from "./session/mode";

// Types
export type { CommandSpec, DeviceFilter, InterfaceContext, SessionApi } from "./types";

// Errors
export { CliError, IncompleteCommandError, InvalidModeError, SyntaxError, ValidationError } from "./errors/errors";

// Building blocks (exported for tests / future REPL front-ends)
export { tokenize } from "./lexer/lexer";
export { analyzePattern, matchPattern, usageFromPattern, type Params, type PatternProgress } from "./parser/matcher";
export { allCommands } from "./commands";
export { renderHelp } from "./help/help";
