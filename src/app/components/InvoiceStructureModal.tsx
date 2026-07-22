import { useEffect, useState } from "react";
import { AlertCircle, ImageUp, Loader2, Plus, Trash2 } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { useAuth } from "../lib/auth";
import { supabase, DEFAULT_INVOICE_SETTINGS, type InvoiceStructureSettings } from "../lib/supabase";

// Combined company-branding + per-template settings panel behind the Invoices
// page "Invoice Structure" button. Everything here is per-company and feeds the
// invoice PDF templates — no company name/logo/contact is ever hardcoded.

const IMG_MAX = 400 * 1024; // 400 KB — keeps the base64 row light

type Props = { isOpen: boolean; onClose: () => void };

export default function InvoiceStructureModal({ isOpen, onClose }: Props) {
  const { company, refreshProfile } = useAuth();

  const [legalName, setLegalName] = useState("");
  const [registrationLine, setRegistrationLine] = useState("");
  const [headOffice, setHeadOffice] = useState("");
  const [email, setEmail] = useState("");
  const [phones, setPhones] = useState<string[]>([""]);
  const [website, setWebsite] = useState("");
  const [taxNtn, setTaxNtn] = useState("");
  const [signatureLabel, setSignatureLabel] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [stampUrl, setStampUrl] = useState<string | null>(null);
  const [settings, setSettings] = useState<InvoiceStructureSettings>(DEFAULT_INVOICE_SETTINGS);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !company) return;
    setLegalName(company.legal_name ?? "");
    setRegistrationLine(company.registration_line ?? "");
    setHeadOffice(company.legal_address ?? "");
    setEmail(company.contact_email ?? "");
    const ph = company.contact_phones ?? (company.contact_phone ? [company.contact_phone] : []);
    setPhones(ph.length ? ph : [""]);
    setWebsite(company.website ?? "");
    setTaxNtn(company.tax_ntn ?? "");
    setSignatureLabel(company.signature_label ?? "");
    setLogoUrl(company.logo_url ?? null);
    setStampUrl(company.stamp_url ?? null);
    setSettings({ ...DEFAULT_INVOICE_SETTINGS, ...(company.invoice_settings ?? {}) });
    setError(null);
  }, [isOpen, company]);

  const pickImage = (file: File, set: (v: string | null) => void) => {
    if (file.size > IMG_MAX) {
      setError("Please choose an image under 400 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const cleanPhones = phones.map((p) => p.trim()).filter(Boolean);
    const { error: rpcErr } = await supabase.rpc("update_invoice_structure", {
      p_legal_name: legalName.trim() || null,
      p_registration_line: registrationLine.trim() || null,
      p_legal_address: headOffice.trim() || null,
      p_contact_email: email.trim() || null,
      p_contact_phones: cleanPhones,
      p_website: website.trim() || null,
      p_tax_ntn: taxNtn.trim() || null,
      p_signature_label: signatureLabel.trim() || null,
      p_logo_url: logoUrl,
      p_stamp_url: stampUrl,
      p_invoice_settings: settings,
    });
    setSaving(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    await refreshProfile();
    onClose();
  };

  const setToggle = (key: keyof InvoiceStructureSettings, val: boolean) =>
    setSettings((s) => ({ ...s, [key]: val }));

  const setWatermark = (v: string | null) => setSettings((s) => ({ ...s, watermark_url: v ?? "" }));

  const label = "block text-sm text-slate-700 mb-1";
  const input = "w-full px-3 py-2 border border-slate-200 rounded-md text-sm";

  const Toggle = ({ k, title, hint }: { k: keyof InvoiceStructureSettings; title: string; hint: string }) => (
    <label className="flex items-start gap-3 p-3 border border-slate-200 rounded-md cursor-pointer hover:bg-slate-50">
      <input
        type="checkbox"
        checked={!!settings[k]}
        onChange={(e) => setToggle(k, e.target.checked)}
        className="mt-0.5 accent-brand-500"
      />
      <span>
        <span className="block text-sm text-slate-800">{title}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );

  const ImageField = ({
    title,
    value,
    onPick,
    onClear,
  }: {
    title: string;
    value: string | null;
    onPick: (f: File) => void;
    onClear: () => void;
  }) => (
    <div>
      <label className={label}>{title}</label>
      <div className="flex items-center gap-3">
        <div className="h-16 w-16 rounded-md border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden shrink-0">
          {value ? (
            <img src={value} alt={title} className="h-full w-full object-contain" />
          ) : (
            <ImageUp className="w-5 h-5 text-slate-400" strokeWidth={1.5} />
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs px-3 py-1.5 border border-slate-200 rounded-md cursor-pointer hover:bg-slate-50">
            Upload
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])}
            />
          </label>
          {value && (
            <button type="button" onClick={onClear} className="text-xs text-danger-600 hover:underline">
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Invoice Structure"
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-md border border-danger-200 bg-danger-50 text-sm text-danger-700">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ── Company Branding ── */}
        <section className="space-y-4">
          <h4 className="text-sm font-semibold text-slate-900">Company Branding</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ImageField title="Company Logo" value={logoUrl} onPick={(f) => pickImage(f, setLogoUrl)} onClear={() => setLogoUrl(null)} />
            <ImageField title="Company Stamp / Seal (optional)" value={stampUrl} onPick={(f) => pickImage(f, setStampUrl)} onClear={() => setStampUrl(null)} />
          </div>
          <div>
            <label className={label}>Legal Company Name</label>
            <input className={input} value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder={company?.name ?? "Company (Pvt) Ltd"} />
          </div>
          <div>
            <label className={label}>Registration Line</label>
            <input className={input} value={registrationLine} onChange={(e) => setRegistrationLine(e.target.value)} placeholder="A company setup under section 32 of The Companies Ordinance, 1984" />
          </div>
          <div>
            <label className={label}>Head Office Address</label>
            <textarea className={input} rows={2} value={headOffice} onChange={(e) => setHeadOffice(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={label}>Email</label>
              <input className={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="accounts@company.com" />
            </div>
            <div>
              <label className={label}>Website</label>
              <input className={input} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="www.company.com" />
            </div>
            <div>
              <label className={label}>Tax / NTN</label>
              <input className={input} value={taxNtn} onChange={(e) => setTaxNtn(e.target.value)} />
            </div>
            <div>
              <label className={label}>Signature Block Label</label>
              <input className={input} value={signatureLabel} onChange={(e) => setSignatureLabel(e.target.value)} placeholder="Accounts Manager" />
            </div>
            <div>
              <label className={label}>Company Prefix (Ref number)</label>
              <input
                className={input}
                value={settings.company_prefix ?? ""}
                onChange={(e) => setSettings((s) => ({ ...s, company_prefix: e.target.value.toUpperCase() }))}
                placeholder="e.g. GGS"
              />
              <p className="text-[10px] text-slate-500 mt-1">Used as the first block of the invoice Ref: {"{Prefix}-{YY}-{ClientPrefix}-{MM}"}.</p>
            </div>
            <div>
              <label className={label}>Brand Accent Colour</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={settings.brand_color || "#1e40af"}
                  onChange={(e) => setSettings((s) => ({ ...s, brand_color: e.target.value }))}
                  className="h-9 w-12 rounded border border-slate-200 p-0.5 shrink-0"
                />
                <input
                  className={input}
                  value={settings.brand_color ?? ""}
                  onChange={(e) => setSettings((s) => ({ ...s, brand_color: e.target.value }))}
                  placeholder="#1e40af (blank = no accent)"
                />
              </div>
            </div>
          </div>

          {/* ── Watermark ── */}
          <div className="border-t border-slate-100 pt-4 space-y-3">
            <ImageField
              title="Watermark Mark (optional — faded, behind the invoice text)"
              value={settings.watermark_url || null}
              onPick={(f) => pickImage(f, setWatermark)}
              onClear={() => setWatermark(null)}
            />
            <Toggle
              k="show_watermark"
              title="Show watermark on invoices"
              hint="Prints the mark large, centered and faint behind the content. Off (or no image) = no watermark at all."
            />
            <div>
              <label className={label}>
                Watermark opacity ({Math.round((settings.watermark_opacity ?? 0.1) * 100)}%)
              </label>
              <input
                type="range"
                min={5}
                max={30}
                value={Math.round((settings.watermark_opacity ?? 0.1) * 100)}
                onChange={(e) => setSettings((s) => ({ ...s, watermark_opacity: Number(e.target.value) / 100 }))}
                className="w-full accent-brand-500"
              />
            </div>
          </div>
          <div>
            <label className={label}>Contact Numbers</label>
            <div className="space-y-2">
              {phones.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className={input}
                    value={p}
                    onChange={(e) => setPhones((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                    placeholder="+92 ..."
                  />
                  <button
                    type="button"
                    onClick={() => setPhones((prev) => (prev.length === 1 ? [""] : prev.filter((_, j) => j !== i)))}
                    className="text-danger-600 hover:bg-danger-50 rounded p-2 shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setPhones((prev) => [...prev, ""])}
                className="text-xs text-brand-600 hover:text-brand-700 inline-flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add number
              </button>
            </div>
          </div>
        </section>

        {/* ── Template Options ── */}
        <section className="space-y-3">
          <h4 className="text-sm font-semibold text-slate-900">Template Options</h4>
          <Toggle k="fixed_show_previous_balance" title="Fixed — show Previous Balance row when applicable" hint="Adds a Previous Balance row when this contract's prior invoice is still unpaid." />
          <Toggle k="variable_show_previous_balance" title="Variable — show Previous Balance row when applicable" hint="Same per-contract carry-forward as Fixed, for attendance-billed invoices." />
          <Toggle k="sla_taxes_dynamic" title="SLA — tax columns from the client's tax profile" hint="Render one tax column per entry in the client's tax_profile (recommended)." />
          <Toggle k="general_show_stamp" title="Show company stamp / seal on invoices" hint="Prints the uploaded stamp image in the signature area." />
        </section>
      </div>
    </Modal>
  );
}
