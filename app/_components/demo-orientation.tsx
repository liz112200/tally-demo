'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight, ChevronDown, Landmark, ListChecks, ReceiptText, UsersRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { orientationSteps, setOrientationDismissed } from '@/lib/demo/orientation';
import { useOrientationDismissed } from '@/app/_lib/use-orientation';

// First-visit pointers for the public demo (lib/demo/orientation.ts). Once
// dismissed, the banner's "Things to try" and Reset demo bring it back.
export function DemoOrientation({ verifyHref, dismissed: fromServer }: { verifyHref: string; dismissed: boolean }) {
  const pathname = usePathname();
  const dismissed = useOrientationDismissed(fromServer);
  if (dismissed || pathname.startsWith('/s/') || pathname.startsWith('/expenses/receipt/')) return null;

  const dismiss = () => setOrientationDismissed(true);

  const icons = [Landmark, ListChecks, UsersRound];
  const [dinner, ...others] = orientationSteps(verifyHref);
  return (
    <div className="border-b bg-card">
      <div className="mx-auto flex max-w-6xl flex-wrap items-start gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
        <Link href={dinner.href}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <ReceiptText aria-hidden className="size-4" />{dinner.title}<ArrowRight aria-hidden className="size-4" />
        </Link>
        <div className="demo-tour">
          <button type="button" popoverTarget="demo-shortcuts" className="demo-tour-trigger">More things to try <ChevronDown size={15} aria-hidden /></button>
          <ul id="demo-shortcuts" popover="auto">
            {others.map((step, index) => {
              const Icon = icons[index];
              return <li key={step.href}>
                <Link href={step.href} onClick={(event) => event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover()}>
                  <Icon size={17} aria-hidden />{step.title}<ArrowRight size={14} aria-hidden />
                </Link>
              </li>;
            })}
          </ul>
        </div>
        <Button variant="ghost" size="icon-sm" className="ml-auto mt-1" onClick={dismiss} aria-label="Dismiss"><X /></Button>
      </div>
    </div>
  );
}
