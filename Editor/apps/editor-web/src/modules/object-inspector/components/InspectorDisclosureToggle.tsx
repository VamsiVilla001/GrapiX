import { ChevronDown, ChevronRight } from "lucide-react";

interface InspectorDisclosureToggleProps {
  contentId: string;
  expanded: boolean;
  headingId: string;
  label: string;
  onToggle: () => void;
}

/** A named advanced-section heading whose button owns only disclosure state. */
export function InspectorDisclosureToggle(props: InspectorDisclosureToggleProps) {
  return (
    <h3 id={props.headingId}>
      <button
        aria-controls={props.contentId}
        aria-expanded={props.expanded}
        className="inspector-disclosure-toggle"
        onClick={props.onToggle}
        type="button"
      >
        {props.expanded
          ? <ChevronDown aria-hidden="true" size={13} />
          : <ChevronRight aria-hidden="true" size={13} />}
        {props.label}
      </button>
    </h3>
  );
}
