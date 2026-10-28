import { useEffect } from "react";
import { driveFileIdFromUrl, openDriveFile } from "../lib/driveFile";

/**
 * Catches every click on a Drive file link anywhere in the signed-in app and
 * opens the file through Bastion instead (lib/driveFile.ts). Mounted once per
 * layout; renders nothing.
 */
export default function DriveLinkGuard() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      const id = driveFileIdFromUrl(a?.href);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      void openDriveFile(id);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
