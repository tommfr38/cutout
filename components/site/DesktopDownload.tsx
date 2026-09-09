'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Apple, Code2, Download, Monitor, X } from 'lucide-react';
import { isDesktopApp } from '@/lib/engine/native';
import {
  DESKTOP_DOWNLOADS,
  SOURCE_URL,
  detectPlatform,
  type DesktopPlatform,
} from '@/lib/site/links';

/** Neither value ever changes after load, so there is nothing to subscribe to. */
const noSubscribe = () => () => {};

export default function DesktopDownload() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Read on the client only, so the server and the first render agree.
  const inApp = useSyncExternalStore(noSubscribe, isDesktopApp, () => false);
  const primary = useSyncExternalStore(
    noSubscribe,
    detectPlatform,
    (): DesktopPlatform => 'windows',
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (
        !dialog.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  // Inside the desktop app there is nothing to download.
  if (inApp) return null;

  const secondary: DesktopPlatform = primary === 'mac' ? 'windows' : 'mac';
  const PrimaryIcon = primary === 'mac' ? Apple : Monitor;
  const SecondaryIcon = secondary === 'mac' ? Apple : Monitor;

  return (
    <div className="desktop-download">
      <button
        ref={trigger}
        className="get-app"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Download size={17} /> Get the desktop app
      </button>
      {open && (
        <div className="app-panel" ref={dialog} aria-label="Download the desktop app">
          <div className="app-panel-top">
            <strong>Cutout for your computer</strong>
            <button onClick={() => setOpen(false)} aria-label="Close">
              <X size={16} />
            </button>
          </div>
          <p>Faster, and it keeps working without a connection.</p>
          <a className="app-primary" href={DESKTOP_DOWNLOADS[primary].file}>
            <PrimaryIcon size={20} /> Download for {DESKTOP_DOWNLOADS[primary].label}
          </a>
          <span className="app-note">{DESKTOP_DOWNLOADS[primary].note}</span>
          <a className="app-secondary" href={DESKTOP_DOWNLOADS[secondary].file}>
            <SecondaryIcon size={16} /> Download for {DESKTOP_DOWNLOADS[secondary].label}
          </a>
          <a className="app-source" href={SOURCE_URL} target="_blank" rel="noreferrer">
            <Code2 size={15} /> View the source code
          </a>
          <span className="app-caveat">
            The builds are not signed, so your system asks you to confirm the first time.
          </span>
        </div>
      )}
    </div>
  );
}
