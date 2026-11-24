import { useT as useTr } from '../i18n';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { Modal, useAction } from './ui';

export type FieldType = 'text' | 'number' | 'bool' | 'select' | 'color' | 'textarea' | 'date' | 'password';
export interface Field {
  key: string; label: string; type?: FieldType; required?: boolean;
  options?: { value: string | number | null; label: string }[];
  optionsFrom?: { path: string; label: string; value?: string; nullLabel?: string };
  createOnly?: boolean; help?: string;
}
export interface Column { key: string; label: string; render?: (row: any) => ReactNode; num?: boolean }

export function useOptions(fields: Field[]) {
  const [opts, setOpts] = useState<Record<string, { value: any; label: string }[]>>({});
  const { branchId } = useSession();
  useEffect(() => {
    fields.filter((f) => f.optionsFrom).forEach(async (f) => {
      const rows = await api.get<any[]>(f.optionsFrom!.path).catch(() => []);
      const list = rows.map((r) => ({ value: r[f.optionsFrom!.value ?? 'id'], label: r[f.optionsFrom!.label] }));
      if (f.optionsFrom!.nullLabel) list.unshift({ value: null, label: f.optionsFrom!.nullLabel });
      setOpts((o) => ({ ...o, [f.key]: list }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);
  return opts;
}

export function FormFields({ fields, value, onChange, isNew }: { fields: Field[]; value: any; onChange: (v: any) => void; isNew: boolean }) {
  const opts = useOptions(fields);
  // A required <select> shows its first option, so store that option too (otherwise the API receives nothing).
  useEffect(() => {
    const missing = fields.filter((f) => f.type === 'select' && f.required && (isNew || !f.createOnly) && value[f.key] == null
      && (f.options ?? opts[f.key])?.length);
    if (missing.length) onChange({ ...value, ...Object.fromEntries(missing.map((f) => [f.key, (f.options ?? opts[f.key])[0].value])) });
  }, [opts, fields, value, onChange, isNew]);
  return (
    <div className="grid2">
      {fields.filter((f) => isNew || !f.createOnly).map((f) => {
        const v = value[f.key];
        const set = (x: any) => onChange({ ...value, [f.key]: x });
        const options = f.options ?? opts[f.key] ?? [];
        if (f.type === 'bool') return (
          <label key={f.key} className="check"><input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} /> {f.label}</label>
        );
        return (
          <label key={f.key} className="field" style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
            {f.label}{f.required ? ' *' : ''}
            {f.type === 'select' ? (
              <select value={v ?? ''} onChange={(e) => {
                const o = options.find((x) => String(x.value ?? '') === e.target.value);
                set(o ? o.value : null);
              }}>
                {!f.required && !options.some((o) => o.value === null) && <option value="">—</option>}
                {options.map((o) => <option key={String(o.value)} value={o.value ?? ''}>{o.label}</option>)}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea value={v ?? ''} onChange={(e) => set(e.target.value)} />
            ) : (
              <input
                type={f.type === 'number' ? 'number' : f.type === 'color' ? 'color' : f.type === 'date' ? 'date' : f.type === 'password' ? 'password' : 'text'}
                step="any" value={v ?? ''} required={f.required}
                onChange={(e) => set(f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
              />
            )}
            {f.help && <span className="small">{f.help}</span>}
          </label>
        );
      })}
    </div>
  );
}

/** Generic list + create/edit page for simple resources. Payloads only include declared fields. */
export function CrudPage({
  title, path, columns, fields, defaults = {}, canWrite = true, toolbar, rowActions, query = '', deleteLabel = 'Deactivate',
}: {
  title: string; path: string; columns: Column[]; fields: Field[]; defaults?: Record<string, any>; canWrite?: boolean;
  toolbar?: ReactNode; rowActions?: (row: any, reload: () => void) => ReactNode; query?: string; deleteLabel?: string | null;
}) {
  const tr = useTr();
  const [rows, setRows] = useState<any[] | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const run = useAction();
  const { branchId } = useSession();
  const opts = useOptions(fields);

  const load = useCallback(() => { api.get<any[]>(path + query).then(setRows).catch(() => setRows([])); }, [path, query]);
  useEffect(() => { load(); }, [load, branchId]);

  const save = async () => {
    const isNew = !edit.id;
    const body: Record<string, any> = {};
    for (const f of fields) {
      if (!isNew && f.createOnly) continue;
      let v = edit[f.key];
      if (v === '' && f.type !== 'text' && f.type !== 'textarea') v = null;
      if (v === undefined) continue;
      body[f.key] = v;
    }
    const r = await run(() => (isNew ? api.post(path, body) : api.patch(`${path}/${edit.id}`, body)), tr("Saved"));
    if (r) { setEdit(null); load(); }
  };

  const display = (col: Column, row: any) => {
    if (col.render) return col.render(row);
    const v = row[col.key];
    const f = fields.find((x) => x.key === col.key);
    if (f && (f.options || opts[f.key])) {
      const o = (f.options ?? opts[f.key]).find((x) => x.value === v);
      if (o) return o.label;
    }
    if (typeof v === 'boolean') return v ? <span className="pill ok">{tr("Yes")}</span> : <span className="pill">{tr("No")}</span>;
    if (col.key === 'color' && typeof v === 'string') return <span className="pill" style={{ background: v, color: '#fff' }}>{v}</span>;
    return v ?? '';
  };

  return (
    <div className="stack">
      <div className="row between">
        <h1>{title}</h1>
        <div className="row">{toolbar}{canWrite && <button className="primary" onClick={() => setEdit({ ...defaults })}>{tr("+ New")}</button>}</div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}<th /></tr></thead>
          <tbody>
            {rows === null && <tr><td colSpan={columns.length + 1} className="muted">{tr("Loading…")}</td></tr>}
            {rows?.length === 0 && <tr><td colSpan={columns.length + 1} className="muted">{tr("Nothing here yet.")}</td></tr>}
            {rows?.map((r) => (
              <tr key={r.id ?? JSON.stringify(r)} className={canWrite ? 'click' : ''} onClick={() => canWrite && setEdit({ ...r })}>
                {columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{display(c, r)}</td>)}
                <td className="right" onClick={(e) => e.stopPropagation()}>
                  <div className="row nowrap" style={{ justifyContent: 'flex-end' }}>
                    {rowActions?.(r, load)}
                    {canWrite && deleteLabel && r.active !== false && r.id && (
                      <button className="sm" onClick={async () => {
                        if (!confirm(tr("{0} this record?", deleteLabel))) return;
                        if (await run(() => api.del(`${path}/${r.id}`), tr("Done"))) load();
                      }}>{deleteLabel}</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={`${edit.id ? 'Edit' : 'New'} — ${title}`} onClose={() => setEdit(null)}>
          <form onSubmit={(e) => { e.preventDefault(); save(); }} className="stack">
            <FormFields fields={fields} value={edit} onChange={setEdit} isNew={!edit.id} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setEdit(null)}>{tr("Cancel")}</button>
              <button type="submit" className="primary">{tr("Save")}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
