// The one popup for "say why before this goes ahead" — a payslip hold, its
// release, a backdated or repeated client payment, archiving a person,
// disabling a login, undoing an import, overriding an alert.
//
// 11 Nov 2026: every one of these used window.prompt, which opens the
// browser's own grey box ("localhost says…") with no Bastion styling, no room
// for the explanation, and a single-line field. This replaces it with the
// house Modal, called the same way: `await askReason({...})` returns the typed
// text, or null when the person cancels. It never decides anything itself —
// the database still refuses the action without a reason, whatever screen
// sends it.

import { ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import Modal from "./Modal";
import Button from "./Button";
import { FormField, Hint, ModalFooter, SubjectCard } from "../pages/super-admin/_assetsKit";

export type AskReasonOptions = {
  title: string;
  /** What the action is about, shown as a card at the top (a person, a payment). */
  subject?: { title: ReactNode; meta?: ReactNode };
  /** The explanation: what will happen, or what the checks found. */
  message?: ReactNode;
  /** Shown as a yellow notice above the field (a warning the person must read). */
  warning?: ReactNode;
  label?: string;
  placeholder?: string;
  hint?: ReactNode;
  confirmLabel?: string;
  tone?: "primary" | "danger";
  /** Shortest acceptable reason, in characters after trimming. Default 1. */
  minLength?: number;
  initial?: string;
};

function ReasonDialog({ opts, done }: { opts: AskReasonOptions; done: (v: string | null) => void }) {
  const [text, setText] = useState(opts.initial ?? "");
  const [err, setErr] = useState<string | null>(null);
  const min = Math.max(1, opts.minLength ?? 1);
  const submit = () => {
    const t = text.trim();
    if (t.length < min) {
      setErr(min > 1 ? `Give a reason of at least a few words (${min} characters).` : "A reason is required.");
      return;
    }
    done(t);
  };
  return (
    <Modal
      isOpen
      onClose={() => done(null)}
      title={opts.title}
      size="sm"
      error={err}
      onDismissError={() => setErr(null)}
      footer={
        <ModalFooter>
          <Button variant="secondary" onClick={() => done(null)}>Cancel</Button>
          <Button variant={opts.tone === "danger" ? "danger" : "primary"} onClick={submit} disabled={!text.trim()}>
            {opts.confirmLabel ?? "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        {opts.subject && <SubjectCard title={opts.subject.title} meta={opts.subject.meta} />}
        {opts.message && <div className="text-sm text-foreground leading-relaxed space-y-2">{opts.message}</div>}
        {opts.warning && <Hint tone="warning">{opts.warning}</Hint>}
        <FormField label={opts.label ?? "Reason"} required hint={opts.hint}>
          <textarea
            autoFocus
            className="w-full min-h-20 px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
            placeholder={opts.placeholder}
            value={text}
            onChange={(e) => { setText(e.target.value); if (err) setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
          />
        </FormField>
      </div>
    </Modal>
  );
}

/** Ask for a reason in a Bastion popup. Resolves to the trimmed text, or null if cancelled. */
export function askReason(opts: AskReasonOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
      // Unmount after the click that closed it has finished propagating.
      setTimeout(() => { root.unmount(); host.remove(); }, 0);
    };
    root.render(<ReasonDialog opts={opts} done={done} />);
  });
}
