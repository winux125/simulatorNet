import { describe, expect, it } from "vitest";
import { EventQueue } from "@sim/sim-core";

describe("EventQueue", () => {
  it("pops events in ascending time order", () => {
    const q = new EventQueue();
    const order: number[] = [];
    q.push(30, () => order.push(30));
    q.push(10, () => order.push(10));
    q.push(20, () => order.push(20));
    while (!q.isEmpty()) q.pop()!.run();
    expect(order).toEqual([10, 20, 30]);
  });

  it("breaks ties by insertion order (FIFO) for determinism", () => {
    const q = new EventQueue();
    const order: string[] = [];
    q.push(5, () => order.push("first"));
    q.push(5, () => order.push("second"));
    q.push(5, () => order.push("third"));
    while (!q.isEmpty()) q.pop()!.run();
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("peekTime reports the earliest scheduled time", () => {
    const q = new EventQueue();
    q.push(100, () => {});
    q.push(50, () => {});
    q.push(75, () => {});
    expect(q.peekTime()).toBe(50);
  });

  it("stays correct under interleaved pushes and pops", () => {
    const q = new EventQueue();
    const seen: number[] = [];
    q.push(40, () => seen.push(40));
    q.push(20, () => seen.push(20));
    q.pop()!.run(); // 20
    q.push(10, () => seen.push(10));
    q.push(30, () => seen.push(30));
    while (!q.isEmpty()) q.pop()!.run();
    expect(seen).toEqual([20, 10, 30, 40]);
  });
});
