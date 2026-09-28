// Opening a link that is NOT part of the app: a new tab.
export async function openExternal(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Open a link that hands control to another app — `tel:`, `mailto:`, `https://wa.me/`. */
export function openSystemLink(url: string): void {
  window.location.href = url;
}
