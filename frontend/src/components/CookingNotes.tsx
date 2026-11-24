import { useT as useTr } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api';

// shortcut: loaded once per page load; POS screens pick up list edits after a refresh.
let cache: Promise<string[]> | null = null;
const presets = () => (cache ??= api.get<any[]>('/menu/cooking-notes?active=true').then((r) => r.map((x) => x.text as string)).catch((): string[] => []));

/**
 * Cooking notes: pick any number of preset notes from the drop-down (shown as removable chips) and/or type your own.
 * The kitchen receives one text: "Well done, No onions, extra crispy".
 */
export function CookingNotes({ value, onChange, max = 300 }: { value: string; onChange: (v: string) => void; max?: number }) {
  const tr = useTr();
  const [list, setList] = useState<string[]>([]);
  // Split an existing note back into chips (known presets) and free text (the rest).
  const [chips, setChips] = useState<string[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    presets().then((p) => {
      setList(p);
      const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
      setChips(parts.filter((x) => p.includes(x)));
      setText(parts.filter((x) => !p.includes(x)).join(', '));
    });
    // only on mount: afterwards this component owns the value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const emit = (c: string[], t: string) => onChange([...c, t.trim()].filter(Boolean).join(', ').slice(0, max));

  return (
    <div className="field">{tr("Cooking notes")}<select aria-label={tr("Add a cooking note from the list")} value="" onChange={(e) => {
        const v = e.target.value;
        if (!v || chips.includes(v)) return;
        const c = [...chips, v];
        setChips(c);
        emit(c, text);
      }}>
        <option value="">{tr("＋ Choose from the list…")}</option>
        {list.filter((x) => !chips.includes(x)).map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      {chips.length > 0 && (
        <div className="row" style={{ gap: '.35rem' }}>
          {chips.map((c) => (
            <span key={c} className="pill info" style={{ fontSize: '.85rem', padding: '.25rem .6rem' }}>
              {c}{' '}
              <button type="button" className="ghost" aria-label={tr("Remove {0}", c)} style={{ minHeight: 0, padding: 0, marginLeft: 4 }}
                onClick={() => { const n = chips.filter((x) => x !== c); setChips(n); emit(n, text); }}>✕</button>
            </span>
          ))}
        </div>
      )}
      <input placeholder={tr("…or type your own note")} value={text} maxLength={max}
        onChange={(e) => { setText(e.target.value); emit(chips, e.target.value); }} />
    </div>
  );
}
