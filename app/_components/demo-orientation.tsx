'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

const DISMISSED_KEY = 'demo-orientation-dismissed';

const STEPS = [
  {
    href: '/?demo=sample-import',
    title: 'Import a sample statement',
    detail: 'Preview, dedup, and auto-categorize a Discover CSV. Import it twice to see dedup catch every row.',
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
] as const;

// First-visit pointers for the public demo. Dismissal is remembered in this
// browser only; storage may be unavailable (private windows), in which case
// the strip simply shows again next visit.
export function DemoOrientation() {
  const pathname = usePathname();
  // Hidden until mounted so the server render never flashes a strip the
  // visitor already dismissed.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // Storage blocked: treat as a first visit.
    }
    setVisible(!dismissed);
  }, []);

  if (!visible || pathname.startsWith('/s/')) return null;

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Ignore; it stays hidden for this page view.
    }
  }

  return (
    <div className="border-b bg-card">
      <div className="mx-auto max-w-6xl px-6 py-3">
        <div className="mb-2 flex items-center">
          <p className="text-[13px] font-medium">Three things to try</p>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            onClick={dismiss}
            aria-label="Dismiss"
          >
            <X />
          </Button>
        </div>
        <ol className="grid gap-2 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.href}>
              <Link
                href={step.href}
                className="block h-full rounded-lg border px-3 py-2 text-xs transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <span className="font-medium text-foreground">
                  {i + 1}. {step.title}
                </span>
                <span className="mt-0.5 block text-muted-foreground">{step.detail}</span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
