import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import bastionCss from "./bastion.css?raw";
import bastionHtml from "./bastion.html?raw";
import { initBastion } from "./interactions";

// Public marketing landing page ("Bastion"), rendered at "/" for unauthenticated
// visitors. It is mounted inside a Shadow DOM so its global-style-heavy CSS (its
// own `*` reset, background, typography) is fully isolated from the CRM and can
// never leak in either direction — the one hard guarantee we want here.
export default function BastionLanding() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Guard against a double-attach (React 18 StrictMode double-invoke in dev).
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${bastionCss}</style>${bastionHtml}`;

    // Every "Sign in" link routes into the CRM login. Tagged with [data-signin]
    // rather than matched on .btn-ghost: the mobile menu has its own sign-in
    // button, and querySelector would only ever have bound the first one.
    const signInLinks = Array.from(
      shadow.querySelectorAll<HTMLAnchorElement>("a[data-signin]"),
    );
    const onSignIn = (e: Event) => { e.preventDefault(); navigate("/login"); };
    signInLinks.forEach((a) => a.addEventListener("click", onSignIn));

    // "Sign up" carries the calculator's current state across to /signup, so a
    // visitor who priced 240 guards with Care on lands on a form already set to
    // 240 guards with Care on. Read at click time rather than bound once: the
    // header button must reflect the slider even though it sits above it.
    const signUpLinks = Array.from(
      shadow.querySelectorAll<HTMLAnchorElement>("a[data-signup]"),
    );
    const onSignUp = (e: Event) => {
      e.preventDefault();
      const guardsEl = shadow.getElementById("pcNum") as HTMLInputElement | null;
      const careEl = shadow.getElementById("pcCare") as HTMLInputElement | null;
      const params = new URLSearchParams();
      const guards = Number(guardsEl?.value ?? "");
      if (Number.isFinite(guards) && guards > 0) params.set("guards", String(Math.floor(guards)));
      if (careEl?.checked) params.set("care", "1");
      const qs = params.toString();
      navigate(qs ? `/signup?${qs}` : "/signup");
    };
    signUpLinks.forEach((a) => a.addEventListener("click", onSignUp));

    const dispose = initBastion(shadow);

    const prevTitle = document.title;
    document.title = "Bastion · The command system for security-services companies";

    return () => {
      signInLinks.forEach((a) => a.removeEventListener("click", onSignIn));
      signUpLinks.forEach((a) => a.removeEventListener("click", onSignUp));
      dispose();
      shadow.innerHTML = "";
      document.title = prevTitle;
    };
  }, [navigate]);

  return <div ref={hostRef} data-bastion-landing />;
}
