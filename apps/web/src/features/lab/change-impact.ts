import type { LabDocument } from "@sim/contracts";

export type LabChangeImpact = "presentation" | "configuration" | "structural";
export type ClassifiedLabChangeImpact = LabChangeImpact | "none";

export class LabChangeImpactError extends Error {
  constructor(
    readonly expected: LabChangeImpact,
    readonly actual: ClassifiedLabChangeImpact,
  ) {
    super(`Lab change was declared '${expected}' but is '${actual}'.`);
    this.name = "LabChangeImpactError";
  }
}

function structuralProjection(document: LabDocument) {
  return {
    nodes: document.topology.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      hardwareProfileId: node.hardwareProfileId,
      interfaces: node.interfaces,
    })),
    links: document.topology.links,
  };
}

function positionProjection(document: LabDocument) {
  return document.topology.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    position: node.position,
  }));
}

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** Conservative classifier: anything outside known presentation/configuration fields is structural. */
export function classifyLabChange(before: LabDocument, after: LabDocument): ClassifiedLabChangeImpact {
  if (before === after) return "none";
  if (before.schemaVersion !== after.schemaVersion || differs(before.simulation, after.simulation)) return "structural";
  if (differs(structuralProjection(before), structuralProjection(after))) return "structural";
  if (differs(before.configurations, after.configurations)) return "configuration";
  if (
    before.id !== after.id
    || before.title !== after.title
    || before.description !== after.description
    || before.instructions !== after.instructions
    || before.expectedOutcome !== after.expectedOutcome
    || before.diagram !== after.diagram
    // Physical placement is presentation, exactly like diagram annotations: it
    // never changes topology, device configuration or protocol behavior, so it
    // stays editable while the lab runs and never triggers a rebuild.
    || before.physical !== after.physical
    || differs(positionProjection(before), positionProjection(after))
  ) return "presentation";
  // A new object containing an unknown/unclassified mutation must never be
  // silently treated as presentation-only.
  return "structural";
}

export function assertLabChangeImpact(
  before: LabDocument,
  after: LabDocument,
  expected: LabChangeImpact,
): ClassifiedLabChangeImpact {
  const actual = classifyLabChange(before, after);
  if (actual !== "none" && actual !== expected) throw new LabChangeImpactError(expected, actual);
  return actual;
}

export function hasStructuralChanges(applied: LabDocument | undefined, draft: LabDocument | undefined): boolean {
  if (!applied || !draft) return false;
  return differs(structuralProjection(applied), structuralProjection(draft));
}
