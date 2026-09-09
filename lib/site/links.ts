/** Where the "GitHub" link in the header points. */
export const SOURCE_URL = 'https://github.com/tommfr38/cutout';

/**
 * Installers, always the newest release. GitHub resolves `latest` for us, so
 * these do not need updating when a version ships.
 */
const RELEASE_BASE = `${SOURCE_URL}/releases/latest/download`;

export type DesktopPlatform = 'mac' | 'windows';

export const DESKTOP_DOWNLOADS: Record<
  DesktopPlatform,
  { label: string; file: string; note: string }
> = {
  mac: {
    label: 'macOS',
    file: `${RELEASE_BASE}/Cutout-mac-universal.dmg`,
    note: 'Works on Apple silicon and Intel Macs.',
  },
  windows: {
    label: 'Windows',
    file: `${RELEASE_BASE}/Cutout-windows-x64-setup.exe`,
    note: 'For 64-bit Windows 10 and 11.',
  },
};

/** Best guess at the visitor's system, defaulting to Windows. */
export function detectPlatform(): DesktopPlatform {
  if (typeof navigator === 'undefined') return 'windows';
  const hinted = (
    navigator as unknown as { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  const source = `${hinted ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /mac|iphone|ipad|ipod/i.test(source) ? 'mac' : 'windows';
}
