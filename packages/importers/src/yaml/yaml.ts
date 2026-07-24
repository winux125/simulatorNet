/**
 * Safe YAML subset parser for Containerlab and CML documents. It supports block
 * mappings and sequences, single-line flow collections, and block scalars
 * (literal/folded) so preserved startup configs survive. It refuses everything
 * that makes YAML dangerous: `!tag`/`!!tag` custom or global tags, anchors and
 * aliases (alias-expansion bombs), and it bounds depth, node count and size.
 * The result is plain JSON data — no class or function is ever instantiated.
 */
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "../config/limits";
import { ImportError, ImportSecurityError } from "../errors/errors";

type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

interface YamlLine {
  indent: number;
  content: string;
}

const INT_PATTERN = /^[-+]?\d+$/;
const FLOAT_PATTERN = /^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/;

export function parseYaml(source: string, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): YamlValue {
  if (source.length > limits.maxTopologyFileBytes) {
    throw new ImportSecurityError("yaml-too-large", "YAML document exceeds the size limit");
  }
  const lines = toLines(source);
  let cursor = 0;
  let nodeCount = 0;

  const countNode = (): void => {
    if (++nodeCount > limits.maxYamlNodes) throw new ImportSecurityError("yaml-too-large", "YAML node count exceeds the limit");
  };

  const isBlank = (line: YamlLine): boolean =>
    line.content === "" || line.content.startsWith("#") || line.content === "---" || line.content === "...";

  const skipBlank = (): void => { while (cursor < lines.length && isBlank(lines[cursor]!)) cursor++; };

  function rejectTagOrAlias(text: string): void {
    if (text.startsWith("!")) throw new ImportSecurityError("yaml-tag-forbidden", `YAML tags are not allowed: ${text.slice(0, 24)}`);
    if (text.startsWith("&") || text.startsWith("*")) {
      throw new ImportSecurityError("yaml-alias-forbidden", `YAML anchors and aliases are not allowed: ${text.slice(0, 24)}`);
    }
  }

  function parseScalar(raw: string): YamlValue {
    const text = raw.trim();
    if (text === "") return null;
    rejectTagOrAlias(text);
    if (text[0] === '"') return parseDoubleQuoted(text);
    if (text[0] === "'") return parseSingleQuoted(text);
    const plain = stripInlineComment(text).trim();
    if (plain === "" || plain === "~" || plain.toLowerCase() === "null") return null;
    if (plain === "true" || plain === "True" || plain === "TRUE") return true;
    if (plain === "false" || plain === "False" || plain === "FALSE") return false;
    if (INT_PATTERN.test(plain)) return Number.parseInt(plain, 10);
    if (FLOAT_PATTERN.test(plain)) return Number.parseFloat(plain);
    return plain;
  }

  function parseInline(raw: string): YamlValue {
    const text = raw.trim();
    if (text[0] === "[") return parseFlowSequence(text);
    if (text[0] === "{") return parseFlowMapping(text);
    return parseScalar(text);
  }

  function parseFlowSequence(text: string): YamlValue {
    if (!text.endsWith("]")) throw new ImportError("yaml-malformed", "Unterminated flow sequence");
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlow(inner).map((item) => { countNode(); return parseInline(item); });
  }

  function parseFlowMapping(text: string): YamlValue {
    if (!text.endsWith("}")) throw new ImportError("yaml-malformed", "Unterminated flow mapping");
    const inner = text.slice(1, -1).trim();
    const map: Record<string, YamlValue> = {};
    if (inner === "") return map;
    for (const pair of splitFlow(inner)) {
      const colon = findMappingColon(pair);
      if (colon < 0) throw new ImportError("yaml-malformed", `Invalid flow mapping entry: ${pair}`);
      countNode();
      map[String(parseScalar(pair.slice(0, colon)))] = parseInline(pair.slice(colon + 1));
    }
    return map;
  }

  function parseBlockScalar(parentIndent: number, indicator: string): string {
    const style = indicator[0]; // "|" literal, ">" folded
    const chomp = indicator.includes("-") ? "strip" : indicator.includes("+") ? "keep" : "clip";
    const body: YamlLine[] = [];
    while (cursor < lines.length) {
      const line = lines[cursor]!;
      if (line.content !== "" && line.indent <= parentIndent) break;
      body.push(line);
      cursor++;
    }
    while (body.length > 0 && body[body.length - 1]!.content === "") body.pop();
    const blockIndent = Math.min(...body.filter((line) => line.content !== "").map((line) => line.indent), Infinity);
    const rendered = body.map((line) => (line.content === "" ? "" : " ".repeat(Math.max(0, line.indent - blockIndent)) + line.content));
    const joined = style === ">" ? foldLines(rendered) : rendered.join("\n");
    if (chomp === "strip") return joined.replace(/\n+$/u, "");
    if (chomp === "keep") return `${joined}\n`;
    return joined === "" ? "" : `${joined}\n`;
  }

  function parseChild(parentIndent: number, depth: number): YamlValue {
    skipBlank();
    if (cursor >= lines.length) return null;
    const line = lines[cursor]!;
    if (line.content === "-" || line.content.startsWith("- ")) {
      return line.indent >= parentIndent ? parseSequence(line.indent, depth + 1) : null;
    }
    return line.indent > parentIndent ? parseNode(line.indent, depth + 1) : null;
  }

  function parseSequence(indent: number, depth: number): YamlValue {
    if (depth > limits.maxYamlDepth) throw new ImportSecurityError("yaml-too-deep", "YAML nesting exceeds the depth limit");
    const items: YamlValue[] = [];
    for (;;) {
      skipBlank();
      if (cursor >= lines.length) break;
      const line = lines[cursor]!;
      if (line.indent !== indent || (line.content !== "-" && !line.content.startsWith("- "))) break;
      countNode();
      if (line.content === "-") {
        cursor++;
        items.push(parseChild(indent, depth));
      } else {
        const itemIndent = indent + 2;
        lines[cursor] = { indent: itemIndent, content: line.content.slice(2).trimEnd() };
        items.push(parseNode(itemIndent, depth + 1));
      }
    }
    return items;
  }

  function parseMapping(indent: number, depth: number): YamlValue {
    if (depth > limits.maxYamlDepth) throw new ImportSecurityError("yaml-too-deep", "YAML nesting exceeds the depth limit");
    const map: Record<string, YamlValue> = {};
    for (;;) {
      skipBlank();
      if (cursor >= lines.length) break;
      const line = lines[cursor]!;
      if (line.indent !== indent) break;
      const colon = findMappingColon(line.content);
      if (colon < 0) break;
      countNode();
      const key = String(parseScalar(line.content.slice(0, colon)));
      const after = line.content.slice(colon + 1).trim();
      cursor++;
      if (after === "") {
        map[key] = parseChild(indent, depth);
      } else if (isBlockScalarIndicator(after)) {
        map[key] = parseBlockScalar(indent, after);
      } else {
        rejectTagOrAlias(after);
        map[key] = parseInline(after);
      }
    }
    return map;
  }

  function parseNode(indent: number, depth: number): YamlValue {
    if (depth > limits.maxYamlDepth) throw new ImportSecurityError("yaml-too-deep", "YAML nesting exceeds the depth limit");
    skipBlank();
    if (cursor >= lines.length) return null;
    const line = lines[cursor]!;
    if (line.content === "-" || line.content.startsWith("- ")) return parseSequence(indent, depth);
    if (findMappingColon(line.content) >= 0) return parseMapping(indent, depth);
    countNode();
    cursor++;
    return isBlockScalarIndicator(line.content) ? parseBlockScalar(indent, line.content) : parseInline(line.content);
  }

  skipBlank();
  if (cursor >= lines.length) return null;
  return parseNode(lines[cursor]!.indent, 0);
}

function toLines(source: string): YamlLine[] {
  return source.split(/\r\n|\r|\n/u).map((raw) => {
    let indent = 0;
    while (indent < raw.length && raw[indent] === " ") indent++;
    if (raw[indent] === "\t") throw new ImportError("yaml-malformed", "Tabs are not allowed for YAML indentation");
    return { indent, content: raw.slice(indent).trimEnd() };
  });
}

function isBlockScalarIndicator(text: string): boolean {
  return /^[|>][+-]?\d*$/u.test(text.trim());
}

function stripInlineComment(text: string): string {
  let quote = "";
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]!;
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (index === 0 || text[index - 1] === " ")) return text.slice(0, index);
  }
  return text;
}

/** Index of the `:` that separates a mapping key from its value, or -1. */
function findMappingColon(content: string): number {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < content.length; index++) {
    const ch = content[index]!;
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "#" && index > 0 && content[index - 1] === " ") return -1;
    else if (ch === ":" && depth === 0 && (index + 1 >= content.length || content[index + 1] === " ")) return index;
  }
  return -1;
}

/** Split a flow body on top-level commas, respecting quotes and nesting. */
function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inner.length; index++) {
    const ch = inner[index]!;
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) { parts.push(inner.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(inner.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function parseDoubleQuoted(text: string): string {
  let out = "";
  let index = 1;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === "\\") {
      const next = text[index + 1];
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else out += next ?? "";
      index += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    index++;
  }
  throw new ImportError("yaml-malformed", "Unterminated double-quoted string");
}

function parseSingleQuoted(text: string): string {
  let out = "";
  let index = 1;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === "'") {
      if (text[index + 1] === "'") { out += "'"; index += 2; continue; }
      return out;
    }
    out += ch;
    index++;
  }
  throw new ImportError("yaml-malformed", "Unterminated single-quoted string");
}

function foldLines(lines: readonly string[]): string {
  let out = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (index === 0) { out = line; continue; }
    out += line === "" || lines[index - 1] === "" ? "\n" : " ";
    out += line;
  }
  return out;
}

export type { YamlValue };
