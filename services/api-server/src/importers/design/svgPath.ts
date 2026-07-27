import type { BezierPath, Vec2 } from "@grapix/shared-types";

const TOKEN = /[a-zA-Z]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi;

export function parseSvgPathData(data: string): BezierPath[] {
  const tokens = data.match(TOKEN) ?? [];
  const paths: BezierPath[] = [];
  let index = 0;
  let command = "";
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let lastControl: Vec2 | null = null;
  let path = emptyPath();

  const number = () => Number(tokens[index++]);
  const point = (relative: boolean): Vec2 => {
    const x = number();
    const y = number();
    return relative ? { x: current.x + x, y: current.y + y } : { x, y };
  };
  const finish = (closed = false) => {
    if (!path.vertices.length) return;
    path.closed = closed;
    paths.push(path);
    path = emptyPath();
    lastControl = null;
  };
  const addAnchor = (anchor: Vec2, incoming: Vec2 = anchor, outgoing: Vec2 = anchor) => {
    path.vertices.push(anchor);
    path.inTangents.push({ x: incoming.x - anchor.x, y: incoming.y - anchor.y });
    path.outTangents.push({ x: outgoing.x - anchor.x, y: outgoing.y - anchor.y });
    current = anchor;
  };

  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++];
    if (!command) break;
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();

    if (upper === "M") {
      const next = point(relative);
      if (path.vertices.length) finish(false);
      addAnchor(next);
      start = next;
      command = relative ? "l" : "L";
    } else if (upper === "L") {
      addAnchor(point(relative));
      lastControl = null;
    } else if (upper === "H") {
      const value = number();
      addAnchor({ x: relative ? current.x + value : value, y: current.y });
      lastControl = null;
    } else if (upper === "V") {
      const value = number();
      addAnchor({ x: current.x, y: relative ? current.y + value : value });
      lastControl = null;
    } else if (upper === "C") {
      const control1 = point(relative);
      const control2 = point(relative);
      const anchor = point(relative);
      if (path.vertices.length) {
        const lastIndex = path.vertices.length - 1;
        path.outTangents[lastIndex] = {
          x: control1.x - path.vertices[lastIndex].x,
          y: control1.y - path.vertices[lastIndex].y
        };
      }
      addAnchor(anchor, control2);
      lastControl = control2;
    } else if (upper === "S") {
      const control1 = lastControl
        ? { x: current.x * 2 - lastControl.x, y: current.y * 2 - lastControl.y }
        : current;
      const control2 = point(relative);
      const anchor = point(relative);
      if (path.vertices.length) {
        const lastIndex = path.vertices.length - 1;
        path.outTangents[lastIndex] = {
          x: control1.x - path.vertices[lastIndex].x,
          y: control1.y - path.vertices[lastIndex].y
        };
      }
      addAnchor(anchor, control2);
      lastControl = control2;
    } else if (upper === "Q") {
      const quadratic = point(relative);
      const anchor = point(relative);
      const control1 = {
        x: current.x + (quadratic.x - current.x) * 2 / 3,
        y: current.y + (quadratic.y - current.y) * 2 / 3
      };
      const control2 = {
        x: anchor.x + (quadratic.x - anchor.x) * 2 / 3,
        y: anchor.y + (quadratic.y - anchor.y) * 2 / 3
      };
      const lastIndex = path.vertices.length - 1;
      if (lastIndex >= 0) {
        path.outTangents[lastIndex] = {
          x: control1.x - path.vertices[lastIndex].x,
          y: control1.y - path.vertices[lastIndex].y
        };
      }
      addAnchor(anchor, control2);
      lastControl = quadratic;
    } else if (upper === "T") {
      const quadratic: Vec2 = lastControl
        ? { x: current.x * 2 - lastControl.x, y: current.y * 2 - lastControl.y }
        : current;
      const anchor = point(relative);
      const control1 = {
        x: current.x + (quadratic.x - current.x) * 2 / 3,
        y: current.y + (quadratic.y - current.y) * 2 / 3
      };
      const control2 = {
        x: anchor.x + (quadratic.x - anchor.x) * 2 / 3,
        y: anchor.y + (quadratic.y - anchor.y) * 2 / 3
      };
      const lastIndex = path.vertices.length - 1;
      if (lastIndex >= 0) {
        path.outTangents[lastIndex] = {
          x: control1.x - path.vertices[lastIndex].x,
          y: control1.y - path.vertices[lastIndex].y
        };
      }
      addAnchor(anchor, control2);
      lastControl = quadratic;
    } else if (upper === "A") {
      // GrapiX stores cubic paths. Preserve the endpoint and let the compatibility
      // report identify that this SVG arc needs a future exact cubic conversion.
      number(); number(); number(); number(); number();
      addAnchor(point(relative));
      lastControl = null;
    } else if (upper === "Z") {
      current = start;
      finish(true);
      command = "";
    } else {
      break;
    }
  }
  finish(false);
  return paths;
}

export function rectanglePath(width: number, height: number): BezierPath {
  return {
    closed: true,
    vertices: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }],
    inTangents: Array.from({ length: 4 }, () => ({ x: 0, y: 0 })),
    outTangents: Array.from({ length: 4 }, () => ({ x: 0, y: 0 }))
  };
}

function emptyPath(): BezierPath {
  return { closed: false, vertices: [], inTangents: [], outTangents: [] };
}
