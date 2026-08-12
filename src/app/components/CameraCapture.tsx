import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, RefreshCw, X, Check, AlertCircle } from "lucide-react";
import Button from "./Button";

// Take a picture with the device camera and hand back a File.
//
// Used for two jobs that both previously accepted uploads only:
//   * a guard's profile photo — taken at the desk with a webcam
//   * a document page — the phone camera standing in for a scanner
//
// getUserMedia is used rather than <input capture>, because capture gives no
// preview and no retake: on a laptop it silently falls back to a file dialog,
// and the operator finds out the photo was unusable only after saving. Here the
// shot is reviewed and retaken before it is accepted.
//
// SECURITY NOTE: getUserMedia requires a secure context. That means HTTPS in
// production and localhost in dev — over plain HTTP on a LAN address the camera
// list comes back empty. The component says so rather than appearing broken.

type Props = {
  open: boolean;
  onClose: () => void;
  /** Receives the captured still. Not called if the user cancels. */
  onCapture: (file: File) => void;
  title?: string;
  /**
   * "user" is the laptop/selfie camera — right for a portrait at a desk.
   * "environment" is the rear camera — right for photographing a document.
   */
  facing?: "user" | "environment";
  /** Base name for the produced file, without extension. */
  fileName?: string;
};

export default function CameraCapture({
  open,
  onClose,
  onCapture,
  title = "Take a photo",
  facing = "user",
  fileName = "capture",
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          window.isSecureContext
            ? "This browser has no camera support."
            : "The camera needs a secure connection (https). Open the site over https and try again.",
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {
          /* autoplay rejection is not fatal — the frame still renders */
        });
      }
    } catch (e) {
      const name = (e as { name?: string }).name;
      // Map the DOMException names onto something an operator can act on.
      setError(
        name === "NotAllowedError"
          ? "Camera permission was refused. Allow camera access for this site, then try again."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No camera was found on this device."
            : name === "NotReadableError"
              ? "The camera is already in use by another application."
              : (e as Error).message || "The camera could not be started.",
      );
    } finally {
      setStarting(false);
    }
  }, [facing]);

  useEffect(() => {
    if (!open) return;
    setShot(null);
    void start();
    // Releasing the stream matters: the camera light stays on and the device
    // stays locked to this tab until every track is stopped.
    return stop;
  }, [open, start, stop]);

  const take = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    setShot(canvas.toDataURL("image/jpeg", 0.9));
  };

  const accept = () => {
    const canvas = document.createElement("canvas");
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          onCapture(new File([blob], `${fileName}-${Date.now()}.jpg`, { type: "image/jpeg" }));
          stop();
          onClose();
        },
        "image/jpeg",
        0.9,
      );
    };
    img.src = shot!;
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => {
          stop();
          onClose();
        }}
      />
      <div
        style={{ marginTop: "var(--safe-top, 0px)", marginBottom: "var(--safe-bottom, 0px)" }}
        className="relative w-full max-w-lg mx-3 rounded-lg bg-white shadow-lg flex flex-col max-h-[90dvh]"
      >
        <div className="flex items-center justify-between border-b border-slate-200 p-4">
          <h3 className="text-base text-slate-900">{title}</h3>
          <button
            onClick={() => {
              stop();
              onClose();
            }}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 min-h-0">
          {error ? (
            <div className="flex items-start gap-2 rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2} />
              <span>{error}</span>
            </div>
          ) : (
            <div className="relative overflow-hidden rounded-md bg-slate-900 aspect-[4/3]">
              {/* The live feed stays mounted behind the still so returning from a
                  retake does not have to restart the camera. */}
              <video
                ref={videoRef}
                playsInline
                muted
                className={`h-full w-full object-cover ${shot ? "invisible" : ""}`}
              />
              {shot && (
                <img src={shot} alt="Captured" className="absolute inset-0 h-full w-full object-cover" />
              )}
              {starting && !shot && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-white/70">
                  Starting camera…
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          {error ? (
            <Button variant="secondary" onClick={() => void start()}>
              <RefreshCw className="w-4 h-4" strokeWidth={1.5} /> Try again
            </Button>
          ) : shot ? (
            <>
              <Button variant="secondary" onClick={() => setShot(null)}>
                <RefreshCw className="w-4 h-4" strokeWidth={1.5} /> Retake
              </Button>
              <Button onClick={accept}>
                <Check className="w-4 h-4" strokeWidth={1.5} /> Use this photo
              </Button>
            </>
          ) : (
            <Button onClick={take} disabled={starting}>
              <Camera className="w-4 h-4" strokeWidth={1.5} /> Capture
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
