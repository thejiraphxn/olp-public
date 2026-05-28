'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type Kind = 'success' | 'error' | 'info';
type Item = { id: number; kind: Kind; text: string };

const ToastCtx = createContext<{
  push: (kind: Kind, text: string) => void;
} | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const idRef = useRef(1);

  const push = useCallback((kind: Kind, text: string) => {
    const id = idRef.current++;
    setItems((xs) => [...xs, { id, kind, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4000);
  }, []);

  const ctx = useMemo(() => ({ push }), [push]);

  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-[320px] pointer-events-none">
        {items.map((t) => (
          <div
            key={t.id}
            className={[
              'pointer-events-auto border rounded px-3 py-2.5 shadow-[3px_3px_0_rgba(0,0,0,0.08)] text-sm flex gap-2 items-start bg-paper',
              t.kind === 'success'
                ? 'border-ok text-ok'
                : t.kind === 'error'
                  ? 'border-live text-live'
                  : 'border-accent text-accent',
            ].join(' ')}
          >
            <span className="font-bold text-lg leading-none w-5 text-center">
              {t.kind === 'success' ? '✓' : t.kind === 'error' ? '!' : 'i'}
            </span>
            <span className="flex-1 text-ink">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  const fallback = useMemo(
    () => ({
      success: (t: string) => console.log('[toast:success]', t),
      error: (t: string) => console.error('[toast:error]', t),
      info: (t: string) => console.log('[toast:info]', t),
    }),
    [],
  );
  if (!ctx) return fallback;
  return {
    success: (t: string) => ctx.push('success', t),
    error: (t: string) => ctx.push('error', t),
    info: (t: string) => ctx.push('info', t),
  };
}
