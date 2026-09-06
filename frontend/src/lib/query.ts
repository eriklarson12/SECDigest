/** Rewrites one query param and keeps every other one. `null` removes it.
 *
 * A filter control that navigates to a bare path drops the filters it does not own —
 * the bug 8.5 fixed on the clearing side, and setting a param needs the same logic.
 * Takes anything that stringifies to a query string, so `ReadonlyURLSearchParams` from
 * `next/navigation` passes without dragging a Next import into a pure module. */
export function withParam(
  path: string,
  params: { toString(): string },
  key: string,
  value: string | null,
): string {
  const next = new URLSearchParams(params.toString());
  if (value === null) next.delete(key);
  else next.set(key, value);
  const query = next.toString();
  return query ? `${path}?${query}` : path;
}
