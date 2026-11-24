export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'error') { super(message); }
}

/** Tenant slug = first URL segment: https://bms.nexusrajan.com/{tenant}/... */
export const tenantSlug = () => window.location.pathname.split('/')[1] ?? '';

const ctxKey = (k: string) => `bms:${tenantSlug()}:${k}`;
export const getBranchId = () => Number(localStorage.getItem(ctxKey('branch'))) || null;
export const getCompanyId = () => Number(localStorage.getItem(ctxKey('company'))) || null;
export function setContext(companyId: number | null, branchId: number | null) {
  if (companyId) localStorage.setItem(ctxKey('company'), String(companyId)); else localStorage.removeItem(ctxKey('company'));
  if (branchId) localStorage.setItem(ctxKey('branch'), String(branchId)); else localStorage.removeItem(ctxKey('branch'));
}

async function request<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'bms' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const b = getBranchId(), c = getCompanyId();
  if (b) headers['X-Branch-Id'] = String(b);
  if (c) headers['X-Company-Id'] = String(c);
  const res = await fetch(base + path, {
    method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.message ?? res.statusText, data?.error);
  return data as T;
}

const t = (m: string) => <T = any>(path: string, body?: unknown) => request<T>(`/api/t/${tenantSlug()}`, m, path, body);
export const api = { get: t('GET'), post: t('POST'), patch: t('PATCH'), put: t('PUT'), del: t('DELETE') };

const p = (m: string) => <T = any>(path: string, body?: unknown) => request<T>('/api/platform', m, path, body);
export const platformApi = { get: p('GET'), post: p('POST'), patch: p('PATCH'), del: p('DELETE') };
