// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DevicePalette } from "./DevicePalette";

describe("DevicePalette switch models", () => {
  it("offers compact, 24-port and 48-port chassis without changing DeviceType", async () => {
    const onSelectKind = vi.fn();
    render(<DevicePalette
      open
      disabled={false}
      selectedKind={undefined}
      selectedHardwareProfileId={undefined}
      activeTool="select"
      onOpenChange={vi.fn()}
      onSelectKind={onSelectKind}
      onTool={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: /^Add L2 Switch$/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Add Access — 24 ports \+ 2 uplinks L2 Switch/ }));
    expect(onSelectKind).toHaveBeenCalledWith("l2-switch", "access-24");
    expect(screen.getByRole("button", { name: /Add Access — 48 ports \+ 4 uplinks L2 Switch/ })).toBeTruthy();
  });
});
