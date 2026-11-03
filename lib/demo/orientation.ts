// The demo's first-visit strip (app/_components/demo-orientation.tsx): what
// it points at, and whether this browser dismissed it.
//
// Dismissal is remembered in localStorage, and was once a dead end: closing
// the strip removed the tour from that browser for good (2026-11-02). The
// banner now offers "Things to try" while it is dismissed, and Reset demo
// brings it back. Storage may be unavailable (private windows); the choice
// then lasts for the page view.

export function orientationSteps(verifyHref: string): { href: string; title: string; detail: string }[] {
  return [
    {
      href: '/accounts',
      title: 'Sync a bank',
      detail: 'Press Sync now on American Express a few times, then answer the purchase held at the cutover: on the CSV, or new?',
    },
    {
      href: verifyHref,
      title: 'Check an account against its statement',
      detail: 'Chase checking’s synced rows count only once its statement matches to the cent. Try the real figures, then a typo.',
    },
    {
      href: '/?q=pizza+night',
      title: 'Split a dinner',
      detail: 'Open Pizza night and split it equally, by amount, or by percent. Rows with a receipt split item by item.',
    },
    {
      href: '/people',
      title: 'Simplify balances',
      detail: 'People shows who owes whom, and the fewest transfers that would settle everyone.',
    },
  ];
}

const KEY = 'demo-orientation-dismissed';
const EVENT = 'demo-orientation-change';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// What this page view knows when storage refuses.
let remembered: boolean | null = null;

function storage(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isOrientationDismissed(store: Store | null = storage()): boolean {
  if (remembered !== null) return remembered;
  try {
    return store?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setOrientationDismissed(dismissed: boolean, store: Store | null = storage()): void {
  remembered = dismissed;
  try {
    if (dismissed) store?.setItem(KEY, '1');
    else store?.removeItem(KEY);
  } catch {
    // Remembered for this page view only.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

// For useSyncExternalStore: the strip and the banner follow one value.
export function subscribeOrientation(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}
