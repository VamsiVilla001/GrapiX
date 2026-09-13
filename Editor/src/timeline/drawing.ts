// The minimal 2D drawing surface the timeline layers draw through (11.10).
//
// Its own module so the panel and the speed graph can both depend on it
// without depending on each other — they are peers that draw on the same
// layer, not a parent and a child.
//
// Structural rather than `CanvasRenderingContext2D` for a reason that matters
// to the tests: painting can then be driven by a recording stub, so *what* was
// drawn and how much of it is assertable without a browser. A test that had to
// obtain a real canvas context could not run in this suite at all.

export interface DrawingContext {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  save(): void;
  restore(): void;
  rect(x: number, y: number, width: number, height: number): void;
  clip(): void;
}
