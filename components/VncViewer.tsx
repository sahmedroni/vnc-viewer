"use client";
import { useEffect, useRef, useState } from "react";

export default function VncViewer({ url, password }: { url: string; password?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    let rfb: any;
    let cancelled = false;

    (async () => {
      // The package ships only core/ (ESM) since 1.5; the `lib/` build no longer exists.
      const { default: RFB } = await import("@novnc/novnc");
      if (cancelled || !ref.current) return;

      rfb = new RFB(ref.current, url, { credentials: { password } });
      rfb.scaleViewport = true;
      rfb.addEventListener("connect", () => setStatus("connected"));
      rfb.addEventListener("disconnect", () => setStatus("disconnected"));
    })();

    return () => {
      cancelled = true;
      rfb?.disconnect();
    };
  }, [url, password]);

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-white">
      <div className="px-4 py-2 text-sm">{status}</div>
      <div ref={ref} className="flex-1" />
    </div>
  );
}