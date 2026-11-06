// The app's top navigation (app/_components/site-header.tsx), as data so a
// test can hold the demo's first-visit strip to it: every page the strip sends
// a visitor to must be in the demo's nav (lib/demo/orientation.test.ts).
export const NAV = [
  // The accounts board is the home page (2026-11-05).
  { href: '/', label: 'Accounts' },
  { href: '/expenses', label: 'Expenses' },
  { href: '/people', label: 'People' },
  { href: '/insights', label: 'Insights' },
  // Rules, categories, the bank's categories, and devices.
  { href: '/settings', label: 'Settings' },
] as const;

// Which nav item a page belongs to: an account's page and bank logins are
// Accounts; anything else by its first segment.
export function navActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/accounts');
  return pathname === href || pathname.startsWith(`${href}/`);
}

// Pages left out of the demo's nav. Empty since the synthetic provider
// (DEMO-SYNC.md) brought /accounts to the demo; it was hidden until then, and
// stayed hidden for a day after, while the strip pointed visitors there.
const DEMO_HIDDEN = new Set<string>();

export function navFor(demo: boolean): readonly { href: string; label: string }[] {
  return NAV.filter(({ href }) => !(demo && DEMO_HIDDEN.has(href)));
}
