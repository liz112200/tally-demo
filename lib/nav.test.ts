import { describe, expect, it } from 'vitest';
import { navActive, navFor } from './nav';

describe('navActive', () => {
  it('counts an account page and bank logins as Accounts, the home page', () => {
    expect(navActive('/', '/')).toBe(true);
    expect(navActive('/', '/accounts/0000')).toBe(true);
    expect(navActive('/', '/accounts/logins')).toBe(true);
    expect(navActive('/', '/expenses')).toBe(false);
  });

  it('owns a page by its first segment, not by a shared prefix', () => {
    expect(navActive('/expenses', '/expenses')).toBe(true);
    expect(navActive('/settings', '/settings')).toBe(true);
    expect(navActive('/people', '/peoplex')).toBe(false);
  });

  it('every page a nav item names is one only it owns', () => {
    const nav = navFor(false).map((n) => n.href);
    expect(nav.length).toBeGreaterThanOrEqual(5);
    for (const href of nav) expect(nav.filter((h) => navActive(h, href))).toEqual([href]);
  });
});
