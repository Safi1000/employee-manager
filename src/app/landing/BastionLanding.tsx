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

    // "Sign in" (the sole .btn-ghost, href="#") routes into the CRM login.
    const signIn = shadow.querySelector<HTMLAnchorElement>(".btn-ghost");
    const onSignIn = (e: Event) => { e.preventDefault(); navigate("/login"); };
    if (signIn) signIn.addEventListener("click", onSignIn);

    const dispose = initBastion(shadow);

    const prevTitle = document.title;
    document.title = "Bastion · The command system for security-services companies";

    return () => {
      if (signIn) signIn.removeEventListener("click", onSignIn);
      dispose();
      shadow.innerHTML = "";
      document.title = prevTitle;
    };
  }, [navigate]);

  return <div ref={hostRef} data-bastion-landing />;
}
