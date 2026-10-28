import { supabase } from "./supabase";

/**
 * Drive files open through Bastion (2026-10-29).
 *
 * Files used to be shared "anyone with the link"; they are private now, so a
 * Drive URL on its own opens nothing. openDriveFile() asks the gdrive-file
 * function, which streams the file only if the caller may read a record that
 * holds it — the same read rules, session and two-factor checks as the rest of
 * the app. <DriveLinkGuard/> routes every Drive link click here, so the screens
 * that render drive_view_url as an <a href> need no change.
 */

const DRIVE_ID = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#\s]*&)?id=)([A-Za-z0-9_-]{10,})/;

export function driveFileIdFromUrl(href: string | null | undefined): string | null {
  const m = href ? DRIVE_ID.exec(href) : null;
  return m ? m[1] : null;
}

export async function openDriveFile(fileId: string): Promise<void> {
  // Open the tab inside the click, before any await, or the browser blocks it.
  const win = window.open("", "_blank");
  if (win) win.document.write("<p style=\"font-family:system-ui,sans-serif;padding:24px\">Opening file…</p>");
  const fail = (msg: string) => {
    if (win) { win.document.body.innerHTML = ""; win.document.body.innerText = msg; } else window.alert(msg);
  };
  try {
    const { data } = await supabase.auth.getSession();
    const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gdrive-file`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.session?.access_token ?? ""}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({} as { error?: string }));
      fail(body.error ?? `Could not open the file (status ${resp.status}).`);
      return;
    }
    const url = URL.createObjectURL(await resp.blob());
    if (win) win.location.href = url; else window.location.href = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/** For code that opened a stored link itself: a Drive link goes through Bastion, anything else opens as before. */
export function openStoredLink(href: string | null | undefined): void {
  const id = driveFileIdFromUrl(href);
  if (id) void openDriveFile(id);
  else if (href) window.open(href, "_blank");
}
