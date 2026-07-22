/**
 * Deterministic discrete-event priority queue.
 *
 * Events are ordered by scheduled time; ties are broken by insertion order
 * (a monotonic sequence number), so the queue is a stable min-heap. This
 * stable tie-break is essential: two events at the same simulated instant must
 * run in the same order every time, or the simulation stops being reproducible.
 */
export interface ScheduledEvent {
  readonly time: number;
  readonly seq: number;
  readonly run: () => void;
}

export class EventQueue {
  private readonly heap: ScheduledEvent[] = [];
  private seqCounter = 0;

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /** Time of the earliest event, or undefined if empty. */
  peekTime(): number | undefined {
    return this.heap[0]?.time;
  }

  push(time: number, run: () => void): void {
    const heap = this.heap;
    heap.push({ time, seq: this.seqCounter++, run });
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(heap[i]!, heap[parent]!)) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  pop(): ScheduledEvent | undefined {
    const heap = this.heap;
    const n = heap.length;
    if (n === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (n > 1) {
      heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftDown(start: number): void {
    const heap = this.heap;
    const n = heap.length;
    let i = start;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.less(heap[left]!, heap[smallest]!)) smallest = left;
      if (right < n && this.less(heap[right]!, heap[smallest]!)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private less(a: ScheduledEvent, b: ScheduledEvent): boolean {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  private swap(i: number, j: number): void {
    const heap = this.heap;
    const tmp = heap[i]!;
    heap[i] = heap[j]!;
    heap[j] = tmp;
  }
}
