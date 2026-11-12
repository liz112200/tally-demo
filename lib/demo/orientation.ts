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
      href: '/',
      title: 'Sync a bank',
      detail: 'Press Sync now on American Express a few times, then answer the purchase held at the cutover: on the CSV, or new?',
    },
    {
      href: verifyHref,
      title: 'Check an account against its statement',
      detail: 'Chase checking’s synced rows count only once its statement matches to the cent. Try the real figures, then a typo.',
    },
    {
      href: '/expenses?q=pizza+night',
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

// The dismissal is a cookie, so the server renders the strip already in its
// final state: kept in localStorage, it was unknown to the server, and the
// strip appeared after load, pushing the band and cards down (2026-11-12).
export const ORIENTATION_COOKIE = 'demo-orientation-dismissed';
const KEY = ORIENTATION_COOKIE;
const EVENT = 'demo-orientation-change';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// What this page view knows when storage refuses.
let remembered: boolean | null = null;

// Read by the server from the request's cookie.
export function dismissedByCookie(value: string | undefined): boolean {
  return value === '1';
}

const cookieStore: Store = {
  getItem: (k) => {
    const pair = document.cookie.split('; ').find((c) => c.startsWith(`${k}=`));
    return pair ? decodeURIComponent(pair.slice(k.length + 1)) : null;
  },
  setItem: (k, v) => {
    document.cookie = `${k}=${encodeURIComponent(v)}; path=/; max-age=31536000; samesite=lax`;
  },
  removeItem: (k) => {
    document.cookie = `${k}=; path=/; max-age=0; samesite=lax`;
  },
};

let adopted = false;
function storage(): Store | null {
  if (typeof window === 'undefined') return null;
  // A dismissal kept in localStorage before the cookie, carried over once.
  if (!adopted) {
    adopted = true;
    try {
      if (window.localStorage.getItem(KEY) === '1') {
        cookieStore.setItem(KEY, '1');
        window.localStorage.removeItem(KEY);
      }
    } catch {
      // Storage refused: nothing to carry over.
    }
  }
  return cookieStore;
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
