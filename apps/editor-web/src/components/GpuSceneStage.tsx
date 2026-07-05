import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import { useEffect, useRef, useState } from "react";
import { GpuSceneRenderer, type GpuRendererCapabilities } from "../rendering/GpuSceneRenderer";

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
      } catch (error) {
        setRendererError(error instanceof Error ? error.message : "GPU renderer failed to initialize");
      }
    }

    void mountRenderer();

    return () => {
      cancelled = true;
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    renderer.resize(props.scene);
    void renderer.renderScene(props.scene, props.objects).catch((error) => {
      setRendererError(error instanceof Error ? error.message : "GPU renderer failed to render");
    });
  }, [props.objects, props.scene]);

  return (
    <div className="gpu-stage-surface" ref={hostRef}>
      {rendererError ? <div className="gpu-renderer-error">{rendererError}</div> : null}
    </div>
  );
}
