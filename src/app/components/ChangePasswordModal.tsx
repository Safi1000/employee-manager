import { useState } from "react";
import { Lock, Loader2 } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { callChangePassword } from "../lib/auth";

interface ChangePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function ChangePasswordModal({ isOpen, onClose }: ChangePasswordModalProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setSuccess(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    const res = await callChangePassword({
      new_password: newPassword,
      current_password: currentPassword,
    });
    setSubmitting(false);

    if ("error" in res && res.error) {
      const msg = res.error === "current_password_incorrect"
        ? "Current password is incorrect."
        : res.error;
      setError(msg);
      return;
    }

    setSuccess(true);
    setTimeout(handleClose, 1500);
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Change Password" size="sm">
      {success ? (
        <div className="text-center py-4">
          <div className="w-12 h-12 bg-success-50 rounded-full flex items-center justify-center mx-auto mb-3">
            <Lock className="w-6 h-6 text-success-600" strokeWidth={1.5} />
          </div>
          <p className="text-sm text-success-700 font-medium">Password changed successfully!</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Current Password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
              placeholder="At least 8 characters"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            />
          </div>

          {error && (
            <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded">{error}</div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Change Password
            </Button>
            <Button type="button" variant="secondary" size="md" onClick={handleClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
