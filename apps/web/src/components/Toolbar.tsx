import type { ChangeEvent } from "react";

interface ToolbarProps {
  ready: boolean;
  dirty: boolean;
  paused: boolean;
  onLoadDemo(): void;
  onLoadFile(file: File): void;
  onSave(): void;
  onReset(): void;
  onRun(): void;
  onStep(): void;
  onPause(): void;
  onApply(): void;
}

export function Toolbar(props: ToolbarProps) {
  const loadFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) props.onLoadFile(file);
    event.target.value = "";
  };
  return (
    <header className="toolbar" aria-label="Simulation toolbar">
      <div className="brand-block">
        <span className="brand-mark" aria-hidden="true">SN</span>
        <div><strong>SimulatorNet</strong><small>Browser lab workspace</small></div>
      </div>
      <div className="toolbar-group" aria-label="Lab files">
        <button type="button" onClick={props.onLoadDemo}>Load demo</button>
        <label className="button-like" htmlFor="load-lab-file">Load JSON</label>
        <input id="load-lab-file" className="visually-hidden" type="file" accept="application/json,.json" onChange={loadFile} />
        <button type="button" disabled={!props.ready} onClick={props.onSave}>Save JSON</button>
      </div>
      <div className="toolbar-group" aria-label="Simulation controls">
        <button type="button" disabled={!props.ready} onClick={props.onReset}>Reset</button>
        <button type="button" disabled={!props.ready || props.paused} onClick={props.onRun}>Run until idle</button>
        <button type="button" disabled={!props.ready || props.paused} onClick={props.onStep}>Step 10 ms</button>
        <button type="button" className={props.paused ? "is-active" : ""} disabled={!props.ready} onClick={props.onPause}>
          {props.paused ? "Resume" : "Pause"}
        </button>
      </div>
      <button type="button" className="apply-button" disabled={!props.ready || !props.dirty} onClick={props.onApply}>
        Apply / Rebuild{props.dirty ? " •" : ""}
      </button>
    </header>
  );
}
