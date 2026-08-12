import { useRef, useState } from "react";
import { Upload, ScanLine, X } from "lucide-react";
import CameraCapture from "./CameraCapture";

// A document slot that accepts a file EITHER from disk or from the camera.
//
// "Scan" here means photographing the page with the rear camera — there is no
// TWAIN/WIA bridge in a browser, so a desktop flatbed scanner still goes
// through its own software and then the Upload button. On a phone or tablet,
// which is where these forms are actually filled in at a site office, the rear
// camera IS the scanner, and this removes the save-to-gallery-then-find-it
// round trip that made photographing a CNIC so tedious.

type Props = {
  label: string;
  /** Called with the chosen file(s). `multiple` decides which shape arrives. */
  onChange: (files: FileList | File | undefined) => void;
  multiple?: boolean;
  /** Restricts the file dialog. The camera always produces a JPEG. */
  accept?: string;
  /** Name shown once something is selected. */
  selectedName?: string | null;
};

export default function DocumentInput({
  label,
  onChange,
  multiple = false,
  accept,
  selectedName,
}: Props) {
  const [camOpen, setCamOpen] = useState(false);
  const [scanned, setScanned] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const clear = () => {
    setScanned(null);
    if (fileRef.current) fileRef.current.value = "";
    onChange(undefined);
  };

  return (
    <div>
      <label className="block text-sm text-slate-700 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple={multiple}
          accept={accept}
          onChange={(e) => {
            setScanned(null);
            onChange(multiple ? e.target.files ?? undefined : e.target.files?.[0]);
          }}
          className="flex-1 min-w-0 px-4 py-2 border border-slate-200 rounded-md text-sm"
        />
        <button
          type="button"
          onClick={() => setCamOpen(true)}
          title="Photograph this document with the camera"
          className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50"
        >
          <ScanLine className="w-4 h-4" strokeWidth={1.5} /> Scan
        </button>
        <Upload className="w-4 h-4 flex-shrink-0 text-slate-400" strokeWidth={1.5} />
      </div>

      {scanned && (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-600">
          <span className="truncate">Scanned: {scanned.name}</span>
          <button type="button" onClick={clear} className="text-danger-600 hover:underline inline-flex items-center gap-0.5">
            <X className="w-3 h-3" strokeWidth={2} /> remove
          </button>
        </div>
      )}
      {!scanned && selectedName && (
        <p className="mt-1.5 truncate text-xs text-slate-600">{selectedName}</p>
      )}

      <CameraCapture
        open={camOpen}
        onClose={() => setCamOpen(false)}
        onCapture={(file) => {
          setScanned(file);
          // The file input cannot hold a File we made, so it is cleared to stop
          // a stale earlier pick being submitted alongside the scan.
          if (fileRef.current) fileRef.current.value = "";
          if (multiple) {
            const dt = new DataTransfer();
            dt.items.add(file);
            onChange(dt.files);
          } else {
            onChange(file);
          }
        }}
        title={`Scan — ${label}`}
        facing="environment"
        fileName={label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}
      />
    </div>
  );
}
