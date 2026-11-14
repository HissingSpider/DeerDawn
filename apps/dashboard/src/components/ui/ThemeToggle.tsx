import { useTheme, type ThemePreference } from '@/hooks';

/**
 * Light / System / Dark segmented control. "System" (the default) follows the
 * device; Light/Dark are sticky overrides. State lives in useTheme, which
 * persists the choice and reflects it onto <html data-theme> + the browser bar.
 *
 * The root is always `inline-flex`. To hide it at some widths, pass a VARIANT
 * (`max-sm:hidden`), never a bare `hidden`: two base display utilities on one
 * element are resolved by Tailwind's internal sort, which puts `.inline-flex`
 * after `.hidden`, so a bare `hidden` silently does nothing.
 */

const ICON_PROPS = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function SunIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

const OPTIONS: { value: ThemePreference; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <SunIcon /> },
  { value: 'system', label: 'System', icon: <MonitorIcon /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon /> },
];

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { preference, setPreference } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className={`inline-flex items-center gap-0.5 rounded-lg border border-border-subtle bg-overlay-subtle p-0.5 ${className}`}
    >
      {OPTIONS.map((opt) => {
        const active = preference === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.label}
            title={opt.label}
            onClick={() => setPreference(opt.value)}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              active
                ? 'bg-overlay-strong text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {opt.icon}
          </button>
        );
      })}
    </div>
  );
}

export default ThemeToggle;
