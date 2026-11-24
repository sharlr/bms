import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import fr from './locales/fr.json';
import nl from './locales/nl.json';

export const SOFTWARE = { name: 'BMS Restaurant', initials: 'BMS', company: 'NEXUS RAJAN S.A.R.L', version: 'v1.1' };
export const LANGUAGES = [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }, { code: 'nl', label: 'Nederlands' }] as const;
export type Lang = (typeof LANGUAGES)[number]['code'];
export const THEMES = [
  { code: 'gold', label: 'Gold', swatch: '#8f6c1d' },
  { code: 'navy', label: 'Navy', swatch: '#1e3a8a' },
  { code: 'emerald', label: 'Emerald', swatch: '#065f46' },
  { code: 'crimson', label: 'Crimson', swatch: '#991b1b' },
  { code: 'slate', label: 'Slate', swatch: '#0f172a' },
] as const;

// English is the source text; each locale maps English → translation. Missing keys fall back to English.
const DICT: Record<string, Record<string, string>> = { fr, nl };
const isLang = (v: unknown): v is Lang => v === 'en' || v === 'fr' || v === 'nl';

/**
 * Translate an English UI string. Surrounding spaces are kept (JSX text), and {0}, {1}… are filled with args
 * ("Table {0}" → "Tafel T3"). Non-strings pass through unchanged.
 */
export function translate(lang: Lang, s: unknown, ...args: unknown[]): any {
  if (typeof s !== 'string') return s;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
  const out = (lang === 'en' ? undefined : DICT[lang]?.[m[2]]) ?? m[2];
  return m[1] + out.replace(/\{(\d+)\}/g, (_x, i) => String(args[Number(i)] ?? '')) + m[3];
}

function initialLang(): Lang {
  const saved = localStorage.getItem('bms:lang');
  if (isLang(saved)) return saved;
  const nav = navigator.language.slice(0, 2);
  return isLang(nav) ? nav : 'en';
}

const Ctx = createContext<{ lang: Lang; setLang: (l: string) => void }>({ lang: 'en', setLang: () => undefined });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, set] = useState<Lang>(() => { const l = initialLang(); document.documentElement.lang = l; return l; });
  const setLang = useCallback((l: string) => {
    if (!isLang(l)) return;
    localStorage.setItem('bms:lang', l);
    document.documentElement.lang = l;
    set(l);
  }, []);
  const v = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export const useLang = () => useContext(Ctx);
export function useT() {
  const { lang } = useContext(Ctx);
  return useCallback((s: unknown, ...args: unknown[]) => translate(lang, s, ...args), [lang]);
}

/** Compact language switcher for screens without the back-office top bar (login, customer pages). */
export function LangSwitch({ style, onPick }: { style?: React.CSSProperties; onPick?: (lang: string) => void }) {
  const { lang, setLang } = useLang();
  return (
    <select aria-label="Language" value={lang} onChange={(e) => { setLang(e.target.value); onPick?.(e.target.value); }} style={{ width: 'auto', minHeight: 32, padding: '.2rem .4rem', ...style }}>
      {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.code.toUpperCase()} · {l.label}</option>)}
    </select>
  );
}
