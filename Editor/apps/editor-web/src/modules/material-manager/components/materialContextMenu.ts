export interface ContextMenuPlacement {
  left: number;
  top: number;
  openSubmenusLeft: boolean;
}

export function placeMaterialContextMenu(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 248,
  menuHeight = 390,
  gutter = 8
): ContextMenuPlacement {
  const usableWidth = Math.max(0, viewportWidth - gutter * 2);
  const usableHeight = Math.max(0, viewportHeight - gutter * 2);
  const width = Math.min(menuWidth, usableWidth);
  const height = Math.min(menuHeight, usableHeight);
  const left = Math.max(gutter, Math.min(x, viewportWidth - width - gutter));
  const top = Math.max(gutter, Math.min(y, viewportHeight - height - gutter));

  return {
    left,
    top,
    openSubmenusLeft: left + width + menuWidth > viewportWidth - gutter
  };
}
