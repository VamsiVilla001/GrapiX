import { fontDefinitionForText, type SceneObject, type TextSceneObject } from "@grapix/shared-types";
import { CircleAlert } from "lucide-react";
import { useSyncExternalStore } from "react";
import { projectFontRegistry } from "../fonts/ProjectFontRegistry";
import { useEditorStore } from "../store/editorStore";

export function TextFontControls(props: {
  object: TextSceneObject;
  patch: (patch: Partial<SceneObject>) => void;
  compact?: boolean;
}) {
  const fonts = useEditorStore((state) => state.scene.fonts ?? []);
  useSyncExternalStore(
    projectFontRegistry.subscribe,
    projectFontRegistry.snapshot,
    projectFontRegistry.snapshot
  );
  const selected = fontDefinitionForText(fonts, props.object);
  const runtime = selected ? projectFontRegistry.get(selected.fontId) : undefined;
  const weights = selected
    ? [...new Set(selected.faces.map((face) => String(face.weight)))].sort((a, b) => Number(a) - Number(b))
    : ["100", "200", "300", "400", "500", "600", "700", "800", "900"];
  const styles = selected
    ? [...new Set(selected.faces.map((face) => face.style))]
    : ["normal", "italic", "oblique"];

  return (
    <div className={`text-font-controls${props.compact ? " compact" : ""}`}>
      <label>
        Project font
        <select
          value={selected?.fontId ?? ""}
          onChange={(event) => {
            const font = fonts.find((item) => item.fontId === event.target.value);
            if (!font) {
              props.patch({ fontId: undefined } as Partial<SceneObject>);
              return;
            }
            const firstFace = font.faces[0];
            props.patch({
              fontId: font.fontId,
              fontFamily: font.family,
              fallbackFamilies: font.fallbackFamilies,
              fontAssetId: firstFace?.source.kind === "file" ? firstFace.source.assetId : undefined,
              fontWeight: String(firstFace?.weight ?? 400),
              fontStyle: firstFace?.style ?? "normal"
            } as Partial<SceneObject>);
          }}
        >
          <option value="">Unmanaged / system family</option>
          {fonts.map((font) => {
            const status = projectFontRegistry.get(font.fontId)?.status ?? font.status;
            return <option disabled={font.enabled === false} key={font.fontId} value={font.fontId}>
              {font.displayName} · {status.toLowerCase()}
            </option>;
          })}
        </select>
      </label>
      {!selected ? (
        <label>
          System family
          <input
            value={props.object.fontFamily}
            onChange={(event) => props.patch({ fontFamily: event.target.value } as Partial<SceneObject>)}
          />
        </label>
      ) : null}
      <label>
        Weight
        <select
          value={props.object.fontWeight}
          onChange={(event) => props.patch({ fontWeight: event.target.value } as Partial<SceneObject>)}
        >
          {!weights.includes(props.object.fontWeight) ? <option>{props.object.fontWeight}</option> : null}
          {weights.map((weight) => <option key={weight}>{weight}</option>)}
        </select>
      </label>
      <label>
        Style
        <select
          value={props.object.fontStyle ?? "normal"}
          onChange={(event) => props.patch({ fontStyle: event.target.value } as Partial<SceneObject>)}
        >
          {styles.map((style) => <option key={style}>{style}</option>)}
        </select>
      </label>
      <label>
        Text direction
        <select
          value={props.object.direction ?? "auto"}
          onChange={(event) => props.patch({ direction: event.target.value } as Partial<SceneObject>)}
        >
          <option value="auto">Auto / Unicode bidi</option>
          <option value="ltr">Left to right</option>
          <option value="rtl">Right to left</option>
        </select>
      </label>
      <label className="text-font-fallbacks">
        Fallback stack
        <input
          value={(props.object.fallbackFamilies ?? selected?.fallbackFamilies ?? []).join(", ")}
          onChange={(event) => props.patch({
            fallbackFamilies: uniqueFamilies(event.target.value)
          } as Partial<SceneObject>)}
        />
      </label>
      {selected && runtime?.status !== "READY" ? (
        <p className="font-error"><CircleAlert size={12} /> {runtime?.errorMessage ?? `${selected.displayName} is ${runtime?.status.toLowerCase() ?? "not loaded"}`}</p>
      ) : null}
    </div>
  );
}

function uniqueFamilies(value: string): string[] {
  const seen = new Set<string>();
  return value.split(",").map((item) => item.trim()).filter((item) =>
    item.length > 0 && !seen.has(item.toLowerCase()) && !!seen.add(item.toLowerCase())
  ).slice(0, 12);
}
