import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import { useEffect, useRef, useState } from "react";
import { GpuSceneRenderer, type GpuRendererCapabilities } from "../rendering/GpuSceneRenderer";

// Live registry of mounted renderers, reachable from the devtools console as
// window.__grapixRenderers. Rendering faults in packaged builds are invisible
// (no source maps, error banner instead of console output); this hook lets a
// debugger inspect app.stage / extract pixels from a running instance.
const rendererRegistry: Set<GpuSceneRenderer> =
  ((window as typeof window & { __grapixRenderers?: Set<GpuSceneRenderer> }).__grapixRenderers ??= new Set());

export function GpuSceneStage(props: {
  scene: SceneDocument;
  objects: SceneObject[];
  onCapabilities?: (capabilities: GpuRendererCapabilities) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<GpuSceneRenderer | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const renderer = new GpuSceneRenderer();

    rendererRef.current = renderer;
    rendererRegistry.add(renderer);

    async function mountRenderer() {
      if (!hostRef.current) {
        return;
      }

      try {
        await renderer.mount(hostRef.current, props.scene);

        if (cancelled) {
          renderer.destroy();
          return;
        }

        props.onCapabilities?.(renderer.getCapabilities());
        await renderer.renderScene(props.scene, props.objects);

        if (!cancelled) {
          setRendererError(null);
        }
      } catch (error) {
        setRendererError(error instanceof Error ? error.message : "GPU renderer failed to initialize");
      }
    }

    void mountRenderer();

    return () => {
      cancelled = true;
      renderer.destroy();
      rendererRegistry.delete(renderer);
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    renderer.resize(props.scene);
    void renderer
      .renderScene(props.scene, props.objects)
      // A transient failure must not poison the viewport forever: clear the
      // banner whenever a later render succeeds.
      .then(() => setRendererError(null))
      .catch((error) => {
        setRendererError(error instanceof Error ? error.message : "GPU renderer failed to render");
      });
  }, [props.objects, props.scene]);

  return (
    <div className="gpu-stage-surface" ref={hostRef}>
      {rendererError ? <div className="gpu-renderer-error">{rendererError}</div> : null}
    </div>
  );
}
