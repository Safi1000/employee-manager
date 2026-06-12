import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle, X, Upload, User as UserIcon } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";

/**
 * Item 7: lets the signed-in user (SA / SSA / any role) edit their OWN display
 * name, email and avatar — these are the person's identity in the app shell, not
 * the company's. Writes go to the caller's own profiles row (allowed by the
 * `self_update` RLS policy, which forbids changing only the role).
 */
export default function ProfileModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { profile, refreshProfile } = useAuth();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen || !profile) return;
    setFullName(profile.full_name ?? "");
    setEmail(profile.email ?? "");
    setAvatarUrl(profile.avatar_url ?? null);
    setError(null);
  }, [isOpen, profile]);

  const onPickFile = (file: File) => {
    if (file.size > 512 * 1024) {
      setError("Please choose an image under 512 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatarUrl(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    setError(null);
    const { error: upErr } = await supabase
      .from("profiles")
      .update({
        full_name: fullName.trim() || null,
        email: email.trim() || null,
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", profile.id);
    setSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    await refreshProfile();
    onClose();
  };

  const initials = (fullName || email || "?").trim().slice(0, 1).toUpperCase();

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="My Profile" size="sm">
      <div className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button type="button" onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        <div className="flex items-center gap-4">
          <div className="h-16 w-16 rounded-full overflow-hidden bg-slate-100 border border-slate-200 flex items-center justify-center">
            {avatarUrl ? (
              <img src={avatarUrl} alt="Avatar" className="h-full w-full object-cover" />
            ) : (
              <span className="text-xl text-slate-500">{initials}</span>
            )}
          </div>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPickFile(f);
                e.target.value = "";
              }}
            />
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-1" /> Upload photo
            </Button>
            {avatarUrl && (
              <button
                type="button"
                onClick={() => setAvatarUrl(null)}
                className="ml-2 text-xs text-danger-600 hover:underline"
              >
                Remove
              </button>
            )}
            <p className="text-[10px] text-slate-500 mt-1">PNG/JPG up to 512 KB.</p>
          </div>
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Display Name</label>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            placeholder="Your name"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Display Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            placeholder="you@example.com"
          />
          <p className="text-[10px] text-slate-500 mt-1">
            Shown in the app. This does not change your sign-in email.
          </p>
        </div>

        <div className="flex items-center gap-2 pt-2">
          <Button variant="primary" size="md" onClick={save} disabled={saving} className="flex-1">
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UserIcon className="w-4 h-4 mr-2" />}
            Save Profile
          </Button>
          <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
