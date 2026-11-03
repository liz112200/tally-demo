// The app's top navigation (app/_components/site-header.tsx), as data so a
// test can hold the demo's first-visit strip to it: every page the strip sends
// a visitor to must be in the demo's nav (lib/demo/orientation.test.ts).
export const NAV = [
  { href: '/', label: 'Expenses' },
  { href: '/insights', label: 'Insights' },
  { href: '/people', label: 'People' },
  { href: '/rules', label: 'Rules' },
  { href: '/accounts', label: 'Accounts' },
] as const;

// Pages left out of the demo's nav. Empty since the synthetic provider
// (DEMO-SYNC.md) brought /accounts to the demo; it was hidden until then, and
// stayed hidden for a day after, while the strip pointed visitors there.
const DEMO_HIDDEN = new Set<string>();

export function navFor(demo: boolean): readonly { href: string; label: string }[] {
  return NAV.filter(({ href }) => !(demo && DEMO_HIDDEN.has(href)));
}
