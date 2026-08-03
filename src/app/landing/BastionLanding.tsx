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

    const dispose = initBastion(shadow);

    const prevTitle = document.title;
    document.title = "Bastion · The command system for security-services companies";

    return () => {
      signInLinks.forEach((a) => a.removeEventListener("click", onSignIn));
      dispose();
      shadow.innerHTML = "";
      document.title = prevTitle;
    };
  }, [navigate]);

  return <div ref={hostRef} data-bastion-landing />;
}
