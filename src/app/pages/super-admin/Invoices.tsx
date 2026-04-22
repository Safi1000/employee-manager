import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  AlertCircle,
  X,
  Loader2,
  Trash2,
  Pencil,
  FileText,
  Download,
  Upload,
  Building2,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import {
  supabase,
  INVOICE_ATTACHMENTS_BUCKET,
  type Client,
  type Invoice,
} from "../../lib/supabase";

type InvoiceRow = Invoice & { client?: { name: string; client_code: string } | null };

type InvoiceForm = {
  client_id: string;
  invoice_number: string;
  invoice_date: string;
  invoice_amount: string;
  amount_received: string;
  notes: string;
  attachment_file: File | null;
  existing_attachment_path: string | null;
};

const todayStr = () => new Date().toISOString().slice(0, 10);

const emptyForm = (): InvoiceForm => ({
  client_id: "",
  invoice_number: "",
  invoice_date: todayStr(),
  invoice_amount: "",
  amount_received: "",
  notes: "",
  attachment_file: null,
  existing_attachment_path: null,
});

export default function Invoices() {
  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [clientFilter, setClientFilter] = useState<string>("");

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [form, setForm] = useState<InvoiceForm>(emptyForm());
  const [submitting, setSubmitting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<InvoiceForm>(emptyForm());
  const [editSubmitting, setEditSubmitting] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [cliRes, invRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase
        .from("invoices")
        .select("*, client:client_id(name, client_code)")
        .order("invoice_date", { ascending: false }),
    ]);
    if (cliRes.error) setError(cliRes.error.message);
    if (invRes.error) setError(invRes.error.message);
    setClients((cliRes.data ?? []) as Client[]);
    setInvoices((invRes.data ?? []) as InvoiceRow[]);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const filteredInvoices = useMemo(() => {
    if (!clientFilter) return invoices;
    return invoices.filter((i) => i.client_id === clientFilter);
  }, [invoices, clientFilter]);

  const summary = useMemo(() => {
    let invoiced = 0;
    let received = 0;
    for (const i of filteredInvoices) {
      invoiced += Number(i.invoice_amount);
      received += Number(i.amount_received);
    }
    return { invoiced, received, outstanding: invoiced - received };
  }, [filteredInvoices]);

  const uploadAttachment = async (invoiceId: string, file: File): Promise<string> => {
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${invoiceId}/${Date.now()}_${safe}`;
    const { error: upErr } = await supabase.storage
      .from(INVOICE_ATTACHMENTS_BUCKET)
      .upload(path, file, { upsert: false });
    if (upErr) throw upErr;
    return path;
  };

  const removeAttachment = async (path: string) => {
    await supabase.storage.from(INVOICE_ATTACHMENTS_BUCKET).remove([path]);
  };

  const viewAttachment = (path: string) => {
    const { data } = supabase.storage.from(INVOICE_ATTACHMENTS_BUCKET).getPublicUrl(path);
    if (data?.publicUrl) window.open(data.publicUrl, "_blank");
  };

  const downloadAttachment = async (path: string) => {
    const { data, error: dErr } = await supabase.storage.from(INVOICE_ATTACHMENTS_BUCKET).download(path);
    if (dErr) {
      setError(dErr.message);
      return;
    }
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = path.split("/").pop() ?? "attachment";
    a.click();
    URL.revokeObjectURL(url);
  };

  const validateForm = (f: InvoiceForm): string | null => {
    if (!f.client_id) return "Select a client.";
    if (!f.invoice_number.trim()) return "Enter an invoice number.";
    if (!f.invoice_date) return "Select an invoice date.";
    const amt = Number(f.invoice_amount);
    if (!amt || amt <= 0) return "Enter a positive invoice amount.";
    const received = f.amount_received ? Number(f.amount_received) : 0;
    if (received < 0) return "Amount received cannot be negative.";
    if (received > amt) return "Amount received cannot exceed invoice amount.";
    return null;
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateForm(form);
    if (err) {
      setError(err);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const invAmt = Number(form.invoice_amount);
      const recAmt = form.amount_received ? Number(form.amount_received) : 0;
      const { data, error: insErr } = await supabase
        .from("invoices")
        .insert({
          client_id: form.client_id,
          invoice_number: form.invoice_number.trim(),
          invoice_date: form.invoice_date,
          invoice_amount: invAmt,
          amount_received: recAmt,
          notes: form.notes.trim() || null,
          attachment_path: null,
        })
        .select()
        .single();
      if (insErr) throw insErr;
      let path: string | null = null;
      if (form.attachment_file) {
        path = await uploadAttachment((data as Invoice).id, form.attachment_file);
        const { error: upErr } = await supabase
          .from("invoices")
          .update({ attachment_path: path, updated_at: new Date().toISOString() })
          .eq("id", (data as Invoice).id);
        if (upErr) throw upErr;
      }
      setForm(emptyForm());
      setIsAddOpen(false);
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (row: InvoiceRow) => {
    setEditingId(row.id);
    setEditForm({
      client_id: row.client_id,
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date,
      invoice_amount: String(row.invoice_amount),
      amount_received: String(row.amount_received),
      notes: row.notes ?? "",
      attachment_file: null,
      existing_attachment_path: row.attachment_path,
    });
    setIsEditOpen(true);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    const err = validateForm(editForm);
    if (err) {
      setError(err);
      return;
    }
    setEditSubmitting(true);
    setError(null);
    try {
      let path: string | null = editForm.existing_attachment_path;
      if (editForm.attachment_file) {
        if (path) await removeAttachment(path);
        path = await uploadAttachment(editingId, editForm.attachment_file);
      }
      const invAmt = Number(editForm.invoice_amount);
      const recAmt = editForm.amount_received ? Number(editForm.amount_received) : 0;
      const { error: upErr } = await supabase
        .from("invoices")
        .update({
          client_id: editForm.client_id,
          invoice_number: editForm.invoice_number.trim(),
          invoice_date: editForm.invoice_date,
          invoice_amount: invAmt,
          amount_received: recAmt,
          notes: editForm.notes.trim() || null,
          attachment_path: path,
          updated_at: new Date().toISOString(),
        })
        .eq("id", editingId);
      if (upErr) throw upErr;
      setIsEditOpen(false);
      setEditingId(null);
      setEditForm(emptyForm());
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setEditSubmitting(false);
    }
  };

  const clearEditAttachment = async () => {
    if (!editingId || !editForm.existing_attachment_path) return;
    if (!window.confirm("Remove the current attachment?")) return;
    try {
      await removeAttachment(editForm.existing_attachment_path);
      const { error: upErr } = await supabase
        .from("invoices")
        .update({ attachment_path: null, updated_at: new Date().toISOString() })
        .eq("id", editingId);
      if (upErr) throw upErr;
      setEditForm({ ...editForm, existing_attachment_path: null });
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  const handleDelete = async (row: InvoiceRow) => {
    if (!window.confirm(`Delete invoice "${row.invoice_number}"? This cannot be undone.`)) return;
    setError(null);
    try {
      if (row.attachment_path) await removeAttachment(row.attachment_path);
      const { error: delErr } = await supabase.from("invoices").delete().eq("id", row.id);
      if (delErr) throw delErr;
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  return (
    <>
      <Header
        title="Invoices"
        actions={
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setForm(emptyForm());
              setIsAddOpen(true);
            }}
          >
            <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
            New Invoice
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 text-red-700 border border-red-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
            <p className="text-xs text-blue-700 mb-1">Total Invoiced</p>
            <p className="text-2xl text-blue-900">PKR {summary.invoiced.toLocaleString()}</p>
          </div>
          <div className="bg-green-50 p-4 rounded-lg border border-green-200">
            <p className="text-xs text-green-700 mb-1">Total Received</p>
            <p className="text-2xl text-green-900">PKR {summary.received.toLocaleString()}</p>
          </div>
          <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
            <p className="text-xs text-amber-700 mb-1">Outstanding</p>
            <p className="text-2xl text-amber-900">PKR {summary.outstanding.toLocaleString()}</p>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600">Client:</label>
              <select
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">All Clients</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.client_code})
                  </option>
                ))}
              </select>
            </div>
            <div className="ml-auto text-sm text-slate-500">
              {filteredInvoices.length} invoice{filteredInvoices.length === 1 ? "" : "s"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Invoice #</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Invoice Date</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Invoice Amount</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Received</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Outstanding</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Attachment</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading && (
                  <tr>
                    <td colSpan={8} className="px-6 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredInvoices.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-6 py-10 text-center text-slate-500 text-sm">
                      No invoices yet. Click "New Invoice" to create one.
                    </td>
                  </tr>
                )}
                {!loading &&
                  filteredInvoices.map((inv) => {
                    const outstanding = Number(inv.invoice_amount) - Number(inv.amount_received);
                    return (
                      <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 text-sm text-slate-900 font-mono">
                          {inv.invoice_number}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-900">
                          <div className="flex items-center gap-2">
                            <Building2 className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />
                            <span>{inv.client?.name ?? "—"}</span>
                          </div>
                          <div className="text-xs text-slate-500 font-mono ml-5">
                            {inv.client?.client_code ?? ""}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">{inv.invoice_date}</td>
                        <td className="px-6 py-4 text-sm text-blue-600 text-right">
                          PKR {Number(inv.invoice_amount).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-sm text-green-600 text-right">
                          PKR {Number(inv.amount_received).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-sm text-right">
                          <span className={outstanding > 0 ? "text-amber-600" : "text-green-600"}>
                            PKR {outstanding.toLocaleString()}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm">
                          {inv.attachment_path ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => viewAttachment(inv.attachment_path!)}
                                className="text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
                              >
                                <FileText className="w-3.5 h-3.5" strokeWidth={1.5} />
                                View
                              </button>
                              <button
                                type="button"
                                onClick={() => downloadAttachment(inv.attachment_path!)}
                                className="text-slate-600 hover:text-slate-900"
                                title="Download"
                              >
                                <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                              </button>
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(inv)}>
                            <Pencil className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                            Edit
                          </Button>
                          <button
                            type="button"
                            onClick={() => handleDelete(inv)}
                            className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-red-700 hover:bg-red-50"
                            title="Delete invoice"
                          >
                            <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Modal
        isOpen={isAddOpen}
        onClose={() => {
          setIsAddOpen(false);
          setForm(emptyForm());
        }}
        title="New Invoice"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleAdd}>
          <InvoiceFields form={form} setForm={setForm} clients={clients} allowClearAttachment={false} onClearAttachment={() => {}} />
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting ? "Saving…" : "Create Invoice"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsAddOpen(false);
                setForm(emptyForm());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isEditOpen}
        onClose={() => {
          setIsEditOpen(false);
          setEditingId(null);
          setEditForm(emptyForm());
        }}
        title="Edit Invoice"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleEdit}>
          <InvoiceFields
            form={editForm}
            setForm={setEditForm}
            clients={clients}
            allowClearAttachment
            onClearAttachment={clearEditAttachment}
          />
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={editSubmitting}>
              {editSubmitting ? "Saving…" : "Update Invoice"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsEditOpen(false);
                setEditingId(null);
                setEditForm(emptyForm());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function InvoiceFields({
  form,
  setForm,
  clients,
  allowClearAttachment,
  onClearAttachment,
}: {
  form: InvoiceForm;
  setForm: (f: InvoiceForm) => void;
  clients: Client[];
  allowClearAttachment: boolean;
  onClearAttachment: () => void;
}) {
  const outstanding = Math.max(
    0,
    (Number(form.invoice_amount) || 0) - (Number(form.amount_received) || 0)
  );
  return (
    <>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Client *</label>
        <select
          required
          value={form.client_id}
          onChange={(e) => setForm({ ...form, client_id: e.target.value })}
          className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
        >
          <option value="">Select client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.client_code})
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Invoice # *</label>
          <input
            required
            type="text"
            value={form.invoice_number}
            onChange={(e) => setForm({ ...form, invoice_number: e.target.value })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            placeholder="INV-001"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Invoice Date *</label>
          <input
            required
            type="date"
            value={form.invoice_date}
            onChange={(e) => setForm({ ...form, invoice_date: e.target.value })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Invoice Amount (PKR) *</label>
          <input
            required
            type="number"
            min="0"
            step="0.01"
            value={form.invoice_amount}
            onChange={(e) => setForm({ ...form, invoice_amount: e.target.value })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Amount Received (PKR)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.amount_received}
            onChange={(e) => setForm({ ...form, amount_received: e.target.value })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            placeholder="0"
          />
        </div>
      </div>
      <div className="p-3 bg-amber-50 rounded-md border border-amber-200 text-sm">
        <span className="text-amber-700">Outstanding:</span>{" "}
        <span className="text-amber-900">PKR {outstanding.toLocaleString()}</span>
      </div>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Attachment</label>
        {form.existing_attachment_path && !form.attachment_file && (
          <div className="flex items-center gap-2 text-xs text-slate-600 mb-2">
            <FileText className="w-3.5 h-3.5" strokeWidth={1.5} />
            <span className="font-mono truncate flex-1">
              {form.existing_attachment_path.split("/").pop()}
            </span>
            {allowClearAttachment && (
              <button
                type="button"
                onClick={onClearAttachment}
                className="text-red-700 hover:text-red-800"
              >
                Remove
              </button>
            )}
          </div>
        )}
        <label className="flex items-center justify-center gap-2 px-4 py-2 border border-dashed border-slate-300 rounded-md cursor-pointer hover:border-slate-400 text-sm text-slate-600">
          <Upload className="w-4 h-4" strokeWidth={1.5} />
          <span>
            {form.attachment_file
              ? form.attachment_file.name
              : form.existing_attachment_path
              ? "Replace attachment…"
              : "Upload invoice (PDF / image)"}
          </span>
          <input
            type="file"
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) =>
              setForm({ ...form, attachment_file: e.target.files?.[0] ?? null })
            }
          />
        </label>
      </div>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Notes</label>
        <textarea
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={2}
          className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
          placeholder="Optional notes"
        />
      </div>
    </>
  );
}
