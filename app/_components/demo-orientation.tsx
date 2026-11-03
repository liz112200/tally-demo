'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { orientationSteps, setOrientationDismissed } from '@/lib/demo/orientation';
import { useOrientationDismissed } from '@/app/_lib/use-orientation';

// First-visit pointers for the public demo (lib/demo/orientation.ts). Once
// dismissed, the banner's "Things to try" and Reset demo bring it back.
export function DemoOrientation({ verifyHref }: { verifyHref: string }) {
  const pathname = usePathname();
  const dismissed = useOrientationDismissed();
  if (dismissed !== false || pathname.startsWith('/s/')) return null;

  const dismiss = () => setOrientationDismissed(true);

  return (
    <div className="border-b bg-card">
      <div className="mx-auto max-w-6xl px-6 py-3">
        <div className="mb-2 flex items-center">
          <p className="text-[13px] font-medium">Four things to try</p>
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
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {orientationSteps(verifyHref).map((step, i) => (
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
