// Opening a link that is NOT part of the app.
//
// `window.open` inside a WebView either does nothing or — worse — navigates the
// WebView itself, stranding the user on a Google Drive page with no back
// button and no way home. Native builds must hand these to the OS instead.

import { Browser } from "@capacitor/browser";
import { isNative } from "./platform";

/**
 * Open `url` outside the app: a new tab on web, an in-app browser tab
 * (SFSafariViewController / Chrome Custom Tab) on native.
 *
 * The in-app tab is deliberate rather than a full app switch — it keeps the
 * user one dismiss away from the CRM, and it is the presentation Apple and
 * Google both expect for auxiliary web content.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isNative) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Browser.open({ url, presentationStyle: "popover" });
}

/**
 * Open a link that hands control to another system app entirely — a `tel:`,
 * `mailto:` or `https://wa.me/` URL. These must NOT go through the in-app
 * browser tab: it would show a blank page while the OS handles the scheme.
 */
export function openSystemLink(url: string): void {
  window.location.href = url;
}
