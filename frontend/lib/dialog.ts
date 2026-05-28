/**
 * Friendly wrapper over SweetAlert2 — replaces native window.prompt /
 * window.confirm / window.alert with the same shape so callsites stay
 * compact. All helpers no-op gracefully on the server (SSR).
 *
 * Default styling matches the rest of the app (paper bg + accent CTA).
 */
import Swal, { type SweetAlertOptions } from 'sweetalert2';
// SweetAlert2's own stylesheet ships its structural CSS (positioning,
// animation, backdrop). Imported from app/layout.tsx so the rules are
// always present — Next.js disallows global CSS imports from non-layout
// files. Our customClass below layers Tailwind utilities on top.

const baseTheme: SweetAlertOptions = {
  buttonsStyling: false,
  customClass: {
    popup: 'border border-ink rounded bg-paper text-ink',
    title: 'text-base font-bold text-ink',
    htmlContainer: 'text-sm text-ink-soft',
    confirmButton:
      'inline-flex items-center justify-center gap-1.5 rounded border font-semibold transition-colors disabled:opacity-50 ' +
      'h-9 px-3.5 text-sm bg-accent text-white border-accent hover:brightness-110 mr-2',
    cancelButton:
      'inline-flex items-center justify-center gap-1.5 rounded border font-semibold transition-colors disabled:opacity-50 ' +
      'h-9 px-3.5 text-sm bg-transparent text-ink border-ink hover:bg-paper-alt',
    denyButton:
      'inline-flex items-center justify-center gap-1.5 rounded border font-semibold transition-colors disabled:opacity-50 ' +
      'h-9 px-3.5 text-sm bg-live text-white border-live hover:brightness-110 mr-2',
    // Only theme the colors — SweetAlert sizes the input itself (width,
    // padding, font). Adding `w-full px-2` on top double-applies padding
    // and overflows the popup. `!` because the Swal stylesheet wins on
    // specificity otherwise.
    input:
      '!border-ink !text-ink !bg-paper !rounded focus:!border-accent focus:!shadow-none',
  },
};

/** Drop-in replacement for `window.confirm`. */
export async function confirmDialog(
  message: string,
  opts: { title?: string; confirmText?: string; cancelText?: string; danger?: boolean } = {},
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const r = await Swal.fire({
    ...baseTheme,
    title: opts.title ?? 'Are you sure?',
    text: message,
    icon: opts.danger ? 'warning' : 'question',
    showCancelButton: true,
    confirmButtonText: opts.confirmText ?? 'Yes',
    cancelButtonText: opts.cancelText ?? 'Cancel',
    customClass: {
      ...baseTheme.customClass,
      // Use the danger style for the confirm button when it's a destructive action.
      confirmButton: opts.danger
        ? (baseTheme.customClass as any).denyButton
        : (baseTheme.customClass as any).confirmButton,
    },
  });
  return r.isConfirmed;
}

/**
 * Drop-in replacement for `window.prompt`. Returns null on cancel,
 * the entered string on confirm.
 */
export async function promptDialog(
  message: string,
  opts: {
    title?: string;
    initial?: string;
    placeholder?: string;
    inputType?: 'text' | 'password' | 'number' | 'tel' | 'email';
    pattern?: string;
    inputAttributes?: Record<string, string>;
    validate?: (v: string) => string | null; // return error or null
  } = {},
): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const r = await Swal.fire({
    ...baseTheme,
    title: opts.title ?? 'Input required',
    text: message,
    input: opts.inputType === 'password' ? 'password' : 'text',
    inputValue: opts.initial ?? '',
    inputPlaceholder: opts.placeholder,
    inputAttributes: {
      ...(opts.pattern ? { pattern: opts.pattern } : {}),
      ...(opts.inputType ? { inputmode: opts.inputType === 'number' ? 'numeric' : opts.inputType } : {}),
      ...(opts.inputAttributes ?? {}),
    },
    inputValidator: opts.validate
      ? (v: unknown) => opts.validate!(String(v ?? '')) ?? undefined
      : undefined,
    showCancelButton: true,
    confirmButtonText: 'OK',
    cancelButtonText: 'Cancel',
  });
  if (!r.isConfirmed) return null;
  return String(r.value ?? '');
}

/** Drop-in replacement for `window.alert`. Variant maps to a colored icon. */
export async function alertDialog(
  message: string,
  opts: { title?: string; variant?: 'info' | 'success' | 'warn' | 'error' } = {},
): Promise<void> {
  if (typeof window === 'undefined') return;
  const iconMap = {
    info: 'info',
    success: 'success',
    warn: 'warning',
    error: 'error',
  } as const;
  await Swal.fire({
    ...baseTheme,
    title: opts.title ?? '',
    text: message,
    icon: iconMap[opts.variant ?? 'info'],
    confirmButtonText: 'OK',
  });
}
