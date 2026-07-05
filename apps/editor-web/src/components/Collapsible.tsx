import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

export function CollapsiblePanel(props: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);

  return (
    <section className={`collapsible-panel ${props.className ?? ""} ${open ? "open" : "closed"}`}>
      <div className="collapsible-header">
        <button className="collapse-toggle" onClick={() => setOpen((value) => !value)} title={open ? "Collapse" : "Expand"}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <span>{props.title}</span>
        </button>
        {props.actions ? <div className="collapsible-actions">{props.actions}</div> : null}
      </div>
      {open ? <div className="collapsible-body">{props.children}</div> : null}
    </section>
  );
}

export function CollapsibleSection(props: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);

  return (
    <section className={`collapsible-section ${open ? "open" : "closed"}`}>
      <button className="section-toggle" onClick={() => setOpen((value) => !value)} title={open ? "Collapse" : "Expand"}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {props.icon}
        <span>{props.title}</span>
      </button>
      {open ? <div className="section-body">{props.children}</div> : null}
    </section>
  );
}
