import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";

export type ExportFieldOption = { id: string; label: string };
export type ExportFieldGroup = { group: string; fields: ExportFieldOption[] };

interface ExportFieldsModalProps {
  isOpen: boolean;
  onClose: () => void;
  groups: ExportFieldGroup[];
  /** The committed selection. Re-read every time the modal opens, so Cancel
   *  discards whatever was ticked in a session that was not exported. */
  selectedIds: string[];
  /** Fired on Export with the ticked ids, in CATALOGUE order — never tick order.
   *  A sheet whose columns move depending on the order boxes were clicked is a
   *  different sheet each time it is produced. */
  onExport: (ids: string[]) => void;
  /** Rows the export will cover, so the button says what it is about to do. */
  rowCount: number;
  title?: string;
}

export default function ExportFieldsModal({
  isOpen,
  onClose,
  groups,
  selectedIds,
  onExport,
  rowCount,
  title = "Choose columns to export",
}: ExportFieldsModalProps) {
  const [draft, setDraft] = useState<Set<string>>(new Set(selectedIds));
  const [query, setQuery] = useState("");

  // The draft is seeded on OPEN, not on mount: the modal stays mounted between
  // opens, so seeding once would show the second export the first one's ticks
  // even after Cancel.
  useEffect(() => {
    if (isOpen) {
      setDraft(new Set(selectedIds));
      setQuery("");
    }
    // selectedIds is a fresh array each render; keying the effect on it would
    // reseed the draft on every keystroke and make the checkboxes untickable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      groups
        .map((g) => ({
          group: g.group,
          fields: q
            ? g.fields.filter(
                (f) => f.label.toLowerCase().includes(q) || g.group.toLowerCase().includes(q),
              )
            : g.fields,
        }))
        .filter((g) => g.fields.length > 0),
    [groups, q],
  );

  const allIds = useMemo(() => groups.flatMap((g) => g.fields.map((f) => f.id)), [groups]);
  const orderedSelection = () => allIds.filter((id) => draft.has(id));

  const toggle = (id: string) =>
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setMany = (ids: string[], on: boolean) =>
    setDraft((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const chosen = draft.size;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {chosen === 0
              ? "No columns selected"
              : `${chosen} column${chosen === 1 ? "" : "s"} · ${rowCount} row${rowCount === 1 ? "" : "s"}`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="md" onClick={onClose}>
              Cancel
            </Button>
            {/* Disabled at zero rather than exporting an empty sheet: a workbook
                with a title row and nothing under it looks like a failed export
                and is indistinguishable from one. */}
            <Button
              variant="primary"
              size="md"
              disabled={chosen === 0}
              onClick={() => onExport(orderedSelection())}
            >
              Export {chosen > 0 ? `${chosen} column${chosen === 1 ? "" : "s"}` : ""}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search columns…"
              className="w-full pl-9 pr-8 py-2 text-sm border border-border rounded-md bg-input-background focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" strokeWidth={1.5} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => setMany(visible.flatMap((g) => g.fields.map((f) => f.id)), true)}
              className="text-sm text-brand-600 hover:text-brand-700"
            >
              Select all
            </button>
            <span className="text-border">|</span>
            <button
              type="button"
              onClick={() => setMany(visible.flatMap((g) => g.fields.map((f) => f.id)), false)}
              className="text-sm text-brand-600 hover:text-brand-700"
            >
              Clear
            </button>
          </div>
        </div>

        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No column matches “{query}”.</p>
        ) : (
          visible.map((g) => {
            const ids = g.fields.map((f) => f.id);
            const allOn = ids.every((id) => draft.has(id));
            return (
              <div key={g.group} className="border border-border rounded-md">
                <div className="flex items-center justify-between px-3 py-2 bg-muted border-b border-border">
                  <span className="text-sm text-foreground">{g.group}</span>
                  <button
                    type="button"
                    onClick={() => setMany(ids, !allOn)}
                    className="text-xs text-brand-600 hover:text-brand-700"
                  >
                    {allOn ? "Clear group" : "Select group"}
                  </button>
                </div>
                <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {g.fields.map((f) => (
                    <label key={f.id} className="flex items-center gap-2 text-sm text-foreground">
                      <input type="checkbox" checked={draft.has(f.id)} onChange={() => toggle(f.id)} />
                      <span className="truncate" title={f.label}>
                        {f.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
