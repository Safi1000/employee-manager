import { useCallback, useEffect, useState } from "react";
import { MessageCircle, Phone, Plus, Trash2 } from "lucide-react";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth, hasAnyPermission } from "../lib/auth";

/**
 * The people at a client (0637, 3 Nov 2026): who in accounts to chase, the
 * admin contact, the site in-charge — with a call and a WhatsApp link. Read by
 * anyone; added by clients.edit or the follow-up team.
 */
type Contact = { id: string; name: string; role: string | null; phone: string | null; email: string | null; is_primary: boolean };
const waNumber = (phone: string | null) => { const d = (phone ?? "").replace(/\D/g, ""); return d.startsWith("03") ? `92${d.slice(1)}` : d.startsWith("92") ? d : ""; };
const ROLES = ["Accounts", "Admin", "Site in-charge", "Owner", "Other"];

export default function ClientContacts({ clientId }: { clientId: string }) {
  const { profile, company } = useAuth();
  const canEdit = hasAnyPermission(profile, ["clients.edit", "receivables.follow_up"]);
  const [rows, setRows] = useState<Contact[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", role: "Accounts", phone: "", email: "" });

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("client_contacts").select("id, name, role, phone, email, is_primary").eq("client_id", clientId).order("is_primary", { ascending: false }).order("created_at");
    // Before 0637 is applied the table does not exist: show nothing rather than an error.
    if (error) { setRows([]); return; }
    setRows((data ?? []) as Contact[]);
  }, [clientId]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (!company?.id || !f.name.trim()) return;
    const { error } = await supabase.from("client_contacts").insert({ company_id: company.id, client_id: clientId, name: f.name.trim(), role: f.role, phone: f.phone.trim() || null, email: f.email.trim() || null, is_primary: (rows ?? []).length === 0 });
    if (error) { setErr(friendlyDbError(error)); return; }
    setF({ name: "", role: "Accounts", phone: "", email: "" }); setAdding(false); void load();
  };
  const remove = async (id: string) => {
    if (!window.confirm("Remove this contact?")) return;
    const { error } = await supabase.from("client_contacts").delete().eq("id", id);
    if (error) { setErr(friendlyDbError(error)); return; }
    void load();
  };

  if (!rows) return null;
  return (
    <div className="col-span-2 rounded-xl border border-border p-3 text-sm">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="lbl">Contacts</span>
        {canEdit && !adding && <button type="button" onClick={() => setAdding(true)} className="ml-auto inline-flex items-center gap-1 text-xs text-brand-700 dark:text-brand-500 hover:underline"><Plus className="w-3.5 h-3.5" />Add</button>}
      </div>
      {err && <p className="text-xs text-down mb-1">{err}</p>}
      {rows.length === 0 && !adding && <p className="text-xs text-muted-foreground">No one recorded — add who to call in accounts.</p>}
      <ul className="space-y-1">
        {rows.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <span className="flex-1 min-w-0 truncate"><span className="text-foreground">{c.name}</span><span className="text-xs text-muted-foreground">{c.role ? ` · ${c.role}` : ""}{c.email ? ` · ${c.email}` : ""}</span></span>
            {c.phone && <a href={`tel:${c.phone}`} className="p-1 rounded hover:bg-muted" title={c.phone}><Phone className="w-3.5 h-3.5" /></a>}
            {waNumber(c.phone) && <a href={`https://wa.me/${waNumber(c.phone)}`} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-muted" title="WhatsApp"><MessageCircle className="w-3.5 h-3.5" /></a>}
            {canEdit && <button type="button" onClick={() => void remove(c.id)} className="p-1 rounded text-muted-foreground hover:text-down" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>}
          </li>
        ))}
      </ul>
      {adding && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name" className="px-2 py-1.5 rounded-lg border border-border bg-card" />
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} className="px-2 py-1.5 rounded-lg border border-border bg-card">{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
          <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="Mobile (03…)" className="px-2 py-1.5 rounded-lg border border-border bg-card" />
          <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="Email (optional)" className="px-2 py-1.5 rounded-lg border border-border bg-card" />
          <div className="col-span-2 flex gap-2 justify-end">
            <button type="button" onClick={() => setAdding(false)} className="text-xs text-muted-foreground hover:underline">Cancel</button>
            <button type="button" onClick={() => void add()} disabled={!f.name.trim()} className="text-xs font-semibold text-brand-700 dark:text-brand-500 hover:underline disabled:opacity-50">Save contact</button>
          </div>
        </div>
      )}
    </div>
  );
}
