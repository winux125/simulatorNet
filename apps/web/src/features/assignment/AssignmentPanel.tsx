import type { LabDocument } from "@sim/contracts";
import { CheckCircle2, GraduationCap, Send, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import { Button } from "../../ui";
import { assignmentClient, AssignmentApiError, type StudentAssignment } from "./assignment-client";

interface AssignmentPanelProps {
  client: SimulatorClient;
  onOpenDocument(document: LabDocument): Promise<void>;
  onError(message: string): void;
}

type SaveStatus = "idle" | "saving" | "saved" | "submitting";

/**
 * Minimal authenticated student surface: loads the first assigned assignment,
 * mounts its LabDocument into the workspace and offers revision-checked Save and
 * an immutable Submit. The anonymous Local Lab is used whenever this is absent.
 */
export function AssignmentPanel({ client, onOpenDocument, onError }: AssignmentPanelProps) {
  const [assignment, setAssignment] = useState<StudentAssignment>();
  const [instanceId, setInstanceId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [score, setScore] = useState<number>();
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void (async () => {
      const { assignments } = await assignmentClient.listAssignments();
      const first = assignments[0];
      if (!first) return;
      const opened = await assignmentClient.openAssignment(first.id);
      await onOpenDocument({
        ...opened.document,
        instructions: opened.assignment.instructions ?? opened.document.instructions,
      });
      setAssignment(opened.assignment);
      setInstanceId(opened.instance.id);
      setRevision(opened.instance.revision);
    })().catch(() => {
      // No assignment, or the academic API is unavailable: fall back silently to
      // the Local Lab surface rather than surfacing a workspace error.
    });
  }, [onOpenDocument, onError]);

  if (!assignment || !instanceId) return null;

  const persist = async (): Promise<boolean> => {
    const document = await client.request({ type: "SERIALIZE_LAB" });
    const saved = await assignmentClient.saveInstance(instanceId, revision, document);
    setRevision(saved.revision);
    return true;
  };

  const save = () => void (async () => {
    setStatus("saving");
    await persist();
    setStatus("saved");
  })().catch((error) => { setStatus("idle"); reportAssignmentError(error, onError); });

  const submit = () => void (async () => {
    setStatus("submitting");
    await persist();
    const submission = await assignmentClient.submit(instanceId);
    setScore(submission.score ?? undefined);
    setStatus("saved");
  })().catch((error) => { setStatus("idle"); reportAssignmentError(error, onError); });

  return (
    <section className="assignment-bar" aria-label="Organization assignment">
      <div className="assignment-bar__scope"><GraduationCap size={14} aria-hidden="true" /> Organization Assignment</div>
      <div className="assignment-bar__meta">
        <strong>{assignment.title}</strong>
        {assignment.instructions && <span title={assignment.instructions}>{assignment.instructions}</span>}
      </div>
      <div className="assignment-bar__status" role="status">
        {status === "saving" ? "Saving…" : status === "submitting" ? "Submitting…" : `Revision ${revision}`}
        {score !== undefined && <span className="assignment-bar__score"><CheckCircle2 size={13} aria-hidden="true" /> Score {score}</span>}
      </div>
      <div className="assignment-bar__actions">
        <Button size="sm" icon={<Save size={13} />} disabled={status === "saving" || status === "submitting"} onClick={save}>Save</Button>
        <Button size="sm" variant="primary" icon={<Send size={13} />} disabled={status === "saving" || status === "submitting"} onClick={submit}>Submit</Button>
      </div>
    </section>
  );
}

function reportAssignmentError(error: unknown, onError: (message: string) => void): void {
  if (error instanceof AssignmentApiError && error.code === "LAB_INSTANCE_REVISION_CONFLICT") {
    onError("This lab was updated elsewhere. Reload before saving again.");
    return;
  }
  onError(error instanceof Error ? error.message : "Assignment request failed");
}

export default AssignmentPanel;
