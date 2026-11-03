import { describe, expect, it } from 'vitest';
import { navFor } from '../nav';
import { isOrientationDismissed, orientationSteps, setOrientationDismissed } from './orientation';

// The page a link lands under, as the nav names it: /accounts/verify/<id>
// is under /accounts, /?q=... under /.
const section = (href: string) => `/${href.split('?')[0].split('/')[1] ?? ''}`;

describe('the demo strip', () => {
  it('sends a visitor only to pages the demo nav offers', () => {
    // Accounts was missing from the demo nav while the strip's first card
    // sent visitors there (2026-11-02).
    const nav = navFor(true).map((n) => n.href);
    const steps = orientationSteps('/accounts/verify/00000000-0000-4000-8000-000000000000');
    expect(steps.length).toBe(4);
    for (const step of steps) expect(nav, step.title).toContain(section(step.href));
  });

  it('can always be brought back after it is dismissed', () => {
    const stored = new Map<string, string>();
    const store = {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    };
    setOrientationDismissed(true, store);
    expect(isOrientationDismissed(store)).toBe(true);
    setOrientationDismissed(false, store);
    expect(isOrientationDismissed(store)).toBe(false);
    expect(stored.size).toBe(0);
  });

  it('still dismisses for the page view when storage refuses', () => {
    const refusing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    setOrientationDismissed(true, refusing);
    expect(isOrientationDismissed(refusing)).toBe(true);
    setOrientationDismissed(false, refusing);
    expect(isOrientationDismissed(refusing)).toBe(false);
  });
});
