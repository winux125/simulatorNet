// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { assignmentClient, AssignmentApiError } from "./assignment-client";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe("assignmentClient", () => {
  it("lists the student's assignments", async () => {
    const fetchMock = mockFetch(200, { assignments: [{ id: "a1", title: "Lab", status: "published" }] });
    vi.stubGlobal("fetch", fetchMock);
    const result = await assignmentClient.listAssignments();
    expect(result.assignments[0]?.id).toBe("a1");
    const call = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain("/v1/student/assignments");
    expect(call[1].credentials).toBe("include");
  });

  it("opens an assignment and returns the lab document", async () => {
    const fetchMock = mockFetch(200, { assignment: { id: "a1" }, instance: { id: "i1", revision: 1 }, document: { id: "lab" } });
    vi.stubGlobal("fetch", fetchMock);
    const result = await assignmentClient.openAssignment("a1");
    expect(result.instance.id).toBe("i1");
    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.method).toBe("POST");
  });

  it("surfaces a typed error with the server error code on a revision conflict", async () => {
    vi.stubGlobal("fetch", mockFetch(409, { error: { code: "LAB_INSTANCE_REVISION_CONFLICT", message: "stale", details: { currentRevision: 4 } } }));
    const error = await assignmentClient.saveInstance("i1", 1, { id: "lab" } as never).catch((e) => e);
    expect(error).toBeInstanceOf(AssignmentApiError);
    expect((error as AssignmentApiError).code).toBe("LAB_INSTANCE_REVISION_CONFLICT");
    expect((error as AssignmentApiError).status).toBe(409);
  });

  it("preserves domain diagram data in the academic save payload", async () => {
    const fetchMock = mockFetch(200, { id: "i1", revision: 2, status: "in-progress", canonicalHash: "hash" });
    vi.stubGlobal("fetch", fetchMock);
    await assignmentClient.saveInstance("i1", 1, {
      schemaVersion: 1,
      id: "diagram-lab",
      title: "Diagram lab",
      simulation: { seed: 17 },
      topology: { schemaVersion: 1, nodes: [], links: [] },
      configurations: {},
      diagram: {
        annotations: [{
          id: "note",
          type: "text",
          position: { x: 20, y: 30 },
          width: 180,
          content: "Saved presentation note",
          fontSize: 16,
          bold: false,
          italic: false,
          alignment: "left",
          foreground: "#203247",
          zIndex: 1,
          rotation: 0,
        }],
        linkLabels: [],
        linkStyles: [],
      },
    });

    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toMatchObject({
      expectedRevision: 1,
      document: { diagram: { annotations: [{ id: "note", content: "Saved presentation note" }] } },
    });
  });
});
