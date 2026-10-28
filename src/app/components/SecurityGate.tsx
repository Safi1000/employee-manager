import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, LogOut, ShieldCheck, Smartphone } from "lucide-react";
import Button from "./Button";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";

/**
 * Two-factor login and live sessions (0591).
 *
 * Wraps each signed-in layout. After login it decides, before the app renders:
 *  - an authenticator is set up and this session has not passed it  → ask for the code;
 *  - none is set up and the deadline (profiles.mfa_required_from) has passed → set one up, no way round;
 *  - none is set up and the deadline is ahead → the app, with a banner and "Set up now".
 * The database enforces the same rule at the API gate, so this screen is the way
 * through, not the lock.
 *
 * Every minute, and when the window regains focus, it asks my_session_status():
 * a session ended elsewhere ("Sign out everywhere") or a disabled login signs out here.
 */

type Status = {
  alive: boolean;
  disabled: boolean;
  mfa_required_from: string | null;
  mfa_enforced: boolean;
  aal: string;
  factors: number;
};

type Stage = "loading" | "ok" | "challenge" | "enroll";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function SecurityGate({ children }: { children: ReactNode }) {
  const { session, signOut } = useAuth();
  const [stage, setStage] = useState<Stage>("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<string | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);

  const evaluate = useCallback(async () => {
    const [aalRes, factorRes, statusRes] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
      supabase.rpc("my_session_status"),
    ]);
    const s = (statusRes.data ?? null) as Status | null;
    if (s && (!s.alive || s.disabled)) {
      await signOut();
      return;
    }
    const verified = (factorRes.data?.totp ?? []).filter((f) => f.status === "verified");
    if (verified.length > 0 && aalRes.data?.currentLevel !== "aal2") {
      setFactorId(verified[0].id);
      setStage("challenge");
      return;
    }
    if (verified.length === 0 && s?.mfa_enforced) {
      setStage("enroll");
      return;
    }
    setDeadline(verified.length === 0 && s?.mfa_required_from ? s.mfa_required_from : null);
    setStage("ok");
  }, [signOut]);

  useEffect(() => {
    if (!session) return;
    void evaluate();
  }, [session?.user?.id, evaluate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Is this session still alive? A revoked or disabled login stops here within a minute.
  useEffect(() => {
    if (!session) return;
    const check = async () => {
      const { data } = await supabase.rpc("my_session_status");
      const s = (data ?? null) as Status | null;
      if (s && (!s.alive || s.disabled)) await signOut();
    };
    const t = window.setInterval(() => void check(), 60_000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [session?.user?.id, signOut]); // eslint-disable-line react-hooks/exhaustive-deps

  if (stage === "loading") {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (stage === "challenge" && factorId) {
    return <Challenge factorId={factorId} onDone={() => void evaluate()} onSignOut={() => void signOut()} />;
  }
  if (stage === "enroll") {
    return (
      <Shell onSignOut={() => void signOut()}>
        <Enroll required onDone={() => void evaluate()} />
      </Shell>
    );
  }

  return (
    <>
      {deadline && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning-200 bg-warning-50 px-4 py-2 text-sm text-warning-700 dark:text-warning-500">
          <span className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" strokeWidth={1.5} />
            Two-factor login becomes compulsory on {fmtDate(deadline)}. Set it up now: it takes a minute.
          </span>
          <Button size="sm" variant="secondary" onClick={() => setEnrollOpen(true)}>Set up now</Button>
        </div>
      )}
      {enrollOpen ? (
        <Shell onSignOut={() => void signOut()} onBack={() => setEnrollOpen(false)}>
          <Enroll onDone={() => { setEnrollOpen(false); void evaluate(); }} />
        </Shell>
      ) : children}
    </>
  );
}

function Shell({ children, onSignOut, onBack }: { children: ReactNode; onSignOut: () => void; onBack?: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm">
        {children}
        <div className="mt-6 flex items-center justify-between text-xs text-muted-foreground">
          {onBack ? <button type="button" className="hover:text-foreground" onClick={onBack}>Not now</button> : <span />}
          <button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={onSignOut}>
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function CodeInput({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <input
      autoFocus
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      onKeyDown={(e) => { if (e.key === "Enter") onEnter(); }}
      placeholder="6-digit code"
      className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-center font-ledger text-lg tracking-[0.4em] text-foreground"
      aria-label="Authenticator code"
    />
  );
}

function Challenge({ factorId, onDone, onSignOut }: { factorId: string; onDone: () => void; onSignOut: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    setBusy(false);
    if (error) { setErr("That code did not match. Check the time on your phone and try the newest code."); setCode(""); return; }
    onDone();
  };
  return (
    <Shell onSignOut={onSignOut}>
      <div className="flex items-center gap-2 text-foreground">
        <Smartphone className="h-5 w-5" strokeWidth={1.5} />
        <h2 className="text-base font-semibold">Enter your authenticator code</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">Open your authenticator app and type the 6-digit code shown for Bastion.</p>
      <div className="mt-4"><CodeInput value={code} onChange={setCode} onEnter={() => void submit()} /></div>
      {err && <p className="mt-2 text-xs text-danger-700 dark:text-danger-500">{err}</p>}
      <Button className="mt-4 w-full" disabled={code.length !== 6 || busy} onClick={() => void submit()}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
      </Button>
      <p className="mt-3 text-xs text-muted-foreground">Lost your phone? Ask your administrator to reset your two-factor login.</p>
    </Shell>
  );
}

function Enroll({ required = false, onDone }: { required?: boolean; onDone: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // A half-finished setup from before blocks a new one: clear unverified factors first.
      const { data: list } = await supabase.auth.mfa.listFactors();
      for (const f of (list?.all ?? []).filter((x) => x.status !== "verified")) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      // `issuer` is the name the authenticator app shows above the code; left out,
      // Supabase uses the project's Site URL (it read "localhost"). The account
      // line under it is the user's email.
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        issuer: "Bastion",
        friendlyName: `Bastion ${new Date().toISOString().slice(0, 16)}`,
      });
      if (cancelled) return;
      if (error || !data) { setErr(error?.message ?? "Could not start the setup."); return; }
      setQr(data.totp.qr_code);
      setSecret(data.totp.secret);
      setFactorId(data.id);
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    if (!factorId || code.length !== 6 || busy) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    setBusy(false);
    if (error) { setErr("That code did not match. Scan again if needed and type the newest code."); setCode(""); return; }
    onDone();
  };

  return (
    <div>
      <div className="flex items-center gap-2 text-foreground">
        <ShieldCheck className="h-5 w-5" strokeWidth={1.5} />
        <h2 className="text-base font-semibold">Set up two-factor login</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {required ? "Two-factor login is now compulsory. " : ""}
        Install Google Authenticator or Microsoft Authenticator on your phone, scan this code, then type the 6-digit code it shows.
      </p>
      <div className="mt-4 flex justify-center">
        {qr ? (
          // A scanner needs dark modules on true white, whatever the theme — like a PDF, not a screen colour.
          <img src={qr} alt="QR code for your authenticator app" className="h-44 w-44 rounded-lg p-2" style={{ background: "#ffffff" }} />
        ) : (
          <div className="flex h-44 w-44 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        )}
      </div>
      {secret && (
        <p className="mt-2 break-all text-center text-xs text-muted-foreground">
          Can't scan? Enter this key: <span className="font-ledger text-foreground">{secret}</span>
        </p>
      )}
      <div className="mt-4"><CodeInput value={code} onChange={setCode} onEnter={() => void submit()} /></div>
      {err && <p className="mt-2 text-xs text-danger-700 dark:text-danger-500">{err}</p>}
      <Button className="mt-4 w-full" disabled={!factorId || code.length !== 6 || busy} onClick={() => void submit()}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Turn on two-factor login"}
      </Button>
    </div>
  );
}
