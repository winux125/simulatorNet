/**
 * Tiny, hardened XML reader for VIRL/UNL documents. It is deliberately not a
 * general XML processor: DOCTYPE/DTD and entity declarations are refused
 * outright, only the five predefined entities plus numeric character references
 * are resolved, and depth, node-count and size limits bound the work. There is
 * no external-entity resolution and nothing is fetched.
 */
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "../config/limits";
import { ImportError, ImportSecurityError, type ImportErrorCode } from "../errors/errors";

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  readonly text: string;
}

const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
const isNameChar = (ch: string): boolean => /[A-Za-z0-9_.:-]/.test(ch);

export interface ParseXmlOptions {
  /**
   * Keep element text exactly as written instead of trimming it.
   *
   * Needed when the document stores indentation-significant payload in text
   * nodes: Packet Tracer writes a running-config as one `<LINE>` per line, and
   * the shared IOS parser uses a line's leading whitespace to tell a
   * sub-command from a top-level one. Trimming there would silently demote
   * every `ip address`/`switchport` line to unparsed.
   */
  readonly preserveTextWhitespace?: boolean;
}

export function parseXml(
  source: string,
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
  options: ParseXmlOptions = {},
): XmlElement {
  if (source.length > limits.maxTopologyFileBytes) {
    throw new ImportSecurityError("xml-too-large", "XML document exceeds the size limit");
  }
  const lower = source.toLowerCase();
  if (lower.includes("<!doctype")) throw new ImportSecurityError("xml-doctype-forbidden", "XML DOCTYPE/DTD is not allowed");
  if (lower.includes("<!entity")) throw new ImportSecurityError("xml-entity-forbidden", "XML entity declarations are not allowed");

  let pos = 0;
  let nodeCount = 0;

  const fail = (code: ImportErrorCode, message: string): never => {
    throw new ImportError(code, `${message} at offset ${pos}`);
  };

  function decodeEntities(raw: string): string {
    let out = "";
    let index = 0;
    while (index < raw.length) {
      const ch = raw[index]!;
      if (ch !== "&") { out += ch; index++; continue; }
      const semi = raw.indexOf(";", index);
      if (semi < 0 || semi - index > 12) throw new ImportError("xml-malformed", "Unterminated XML entity");
      const name = raw.slice(index + 1, semi);
      if (name === "lt") out += "<";
      else if (name === "gt") out += ">";
      else if (name === "amp") out += "&";
      else if (name === "apos") out += "'";
      else if (name === "quot") out += '"';
      else if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) throw new ImportError("xml-malformed", "Invalid character reference");
        out += String.fromCodePoint(code);
      } else {
        throw new ImportSecurityError("xml-entity-forbidden", `Unsupported XML entity &${name};`);
      }
      index = semi + 1;
    }
    return out;
  }

  function skipMisc(): void {
    for (;;) {
      while (pos < source.length && isSpace(source[pos]!)) pos++;
      if (source.startsWith("<?", pos)) {
        const end = source.indexOf("?>", pos);
        if (end < 0) fail("xml-malformed", "Unterminated processing instruction");
        pos = end + 2;
        continue;
      }
      if (source.startsWith("<!--", pos)) {
        const end = source.indexOf("-->", pos);
        if (end < 0) fail("xml-malformed", "Unterminated comment");
        pos = end + 3;
        continue;
      }
      break;
    }
  }

  function parseName(): string {
    const start = pos;
    while (pos < source.length && isNameChar(source[pos]!)) pos++;
    if (pos === start) fail("xml-malformed", "Expected an XML name");
    return source.slice(start, pos);
  }

  function parseElement(depth: number): XmlElement {
    if (depth > limits.maxXmlDepth) throw new ImportSecurityError("xml-too-deep", "XML nesting exceeds the depth limit");
    pos++; // consume '<'
    const name = parseName();
    const attributes: Record<string, string> = {};
    for (;;) {
      while (pos < source.length && isSpace(source[pos]!)) pos++;
      const ch = source[pos];
      if (ch === "/" || ch === ">" || ch === undefined) break;
      const attrName = parseName();
      while (pos < source.length && isSpace(source[pos]!)) pos++;
      if (source[pos] !== "=") fail("xml-malformed", "Expected '=' in attribute");
      pos++;
      while (pos < source.length && isSpace(source[pos]!)) pos++;
      const quote = source[pos];
      if (quote !== '"' && quote !== "'") fail("xml-malformed", "Expected quoted attribute value");
      pos++;
      const valueStart = pos;
      while (pos < source.length && source[pos] !== quote) pos++;
      const rawValue = source.slice(valueStart, pos);
      pos++; // consume closing quote
      attributes[attrName] = decodeEntities(rawValue);
    }
    let selfClosing = false;
    if (source[pos] === "/") { selfClosing = true; pos++; }
    if (source[pos] !== ">") fail("xml-malformed", "Expected '>'");
    pos++;
    if (++nodeCount > limits.maxXmlNodes) throw new ImportSecurityError("xml-too-large", "XML node count exceeds the limit");

    const children: XmlElement[] = [];
    let text = "";
    if (!selfClosing) {
      for (;;) {
        if (pos >= source.length) fail("xml-malformed", "Unexpected end of document");
        if (source.startsWith("<!--", pos)) { const end = source.indexOf("-->", pos); if (end < 0) fail("xml-malformed", "Unterminated comment"); pos = end + 3; continue; }
        if (source.startsWith("<![CDATA[", pos)) {
          const end = source.indexOf("]]>", pos + 9);
          if (end < 0) fail("xml-malformed", "Unterminated CDATA");
          text += source.slice(pos + 9, end);
          pos = end + 3;
          continue;
        }
        if (source.startsWith("</", pos)) {
          pos += 2;
          const closeName = parseName();
          while (pos < source.length && isSpace(source[pos]!)) pos++;
          if (source[pos] !== ">") fail("xml-malformed", "Expected '>' in closing tag");
          pos++;
          if (closeName !== name) fail("xml-malformed", `Mismatched closing tag </${closeName}> for <${name}>`);
          break;
        }
        if (source[pos] === "<") { children.push(parseElement(depth + 1)); continue; }
        const textStart = pos;
        while (pos < source.length && source[pos] !== "<") pos++;
        text += decodeEntities(source.slice(textStart, pos));
      }
    }
    return { name, attributes, children, text: options.preserveTextWhitespace === true ? text : text.trim() };
  }

  skipMisc();
  if (source[pos] !== "<") fail("xml-malformed", "Expected a root element");
  return parseElement(1);
}

/** Depth-first search for the first descendant (or self) with a local name. */
export function findElement(root: XmlElement, localName: string): XmlElement | undefined {
  const target = localName.toLowerCase();
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (localNameOf(node.name) === target) return node;
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
  }
  return undefined;
}

export function findElements(root: XmlElement, localName: string): XmlElement[] {
  const target = localName.toLowerCase();
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (localNameOf(node.name) === target) out.push(node);
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
  }
  return out;
}

export function localNameOf(name: string): string {
  const colon = name.lastIndexOf(":");
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}
