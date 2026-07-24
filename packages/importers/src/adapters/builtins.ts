/**
 * Registration of the built-in format adapters. Kept out of module top level so
 * importing the package has no side effects; the host (web worker / tests) calls
 * registerBuiltinImportAdapters() once to make inspectLabImport recognise them.
 */
import { registerImportAdapter, type LabImportAdapter } from "./adapter";
import { eveAdapter, pnetlabAdapter } from "./unl";
import { gns3PortableAdapter, gns3ProjectAdapter } from "./gns3";
import { containerlabAdapter } from "./containerlab";
import { cmlAdapter, virlAdapter } from "./cml";

export const BUILTIN_IMPORT_ADAPTERS: readonly LabImportAdapter[] = [
  pnetlabAdapter,
  eveAdapter,
  gns3ProjectAdapter,
  gns3PortableAdapter,
  containerlabAdapter,
  cmlAdapter,
  virlAdapter,
];

export function registerBuiltinImportAdapters(): void {
  for (const adapter of BUILTIN_IMPORT_ADAPTERS) registerImportAdapter(adapter);
}
