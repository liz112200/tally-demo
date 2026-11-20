'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChartNoAxesColumn, Landmark, LogOut, ReceiptText, Settings2, UsersRound } from 'lucide-react';
import { signOut } from '@/app/_actions/auth';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/app/_components/theme-toggle';
import { navActive, navFor } from '@/lib/nav';

export function SiteHeader({ demo }: { demo: boolean }) {
  const pathname = usePathname();
  // A published share snapshot (/s/<token>) is read by someone who is not
  // the owner and has no access to the app: showing them app navigation
  // would offer links they cannot use and imply the ledger is theirs.
  if (pathname.startsWith('/s/')) return null;
  // Signing in has nowhere to navigate to yet.
  if (pathname === '/sign-in') return null;
  const icons = [Landmark, ReceiptText, UsersRound, ChartNoAxesColumn, Settings2];
  return <header className="ledger-nav">
    <Link href="/" aria-label="Tally, home" className="ledger-brand">Tally<span aria-hidden="true">.</span></Link>
    <nav aria-label="Main navigation">
      {navFor(demo).map(({ href, label }, i) => {
        const Icon = icons[i];
        return <Link key={href} href={href} aria-current={navActive(href, pathname) ? 'page' : undefined}>
          <Icon aria-hidden />{label}
        </Link>;
      })}
    </nav>
    <div className="ledger-identity">{demo ? <><span aria-hidden>R</span>Riley</> : <SignOutButton />}<ThemeToggle /></div>
  </header>;
}

// The header sits in the root layout, outside the page result line, so a
// failure shows here; success navigates to /sign-in.
function SignOutButton() {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      title={problem ?? 'Sign out'}
      aria-label="Sign out"
      onClick={() =>
        startTransition(async () => {
          setProblem(null);
          try {
            const result = await signOut();
            if ('error' in result) setProblem(result.error);
          } catch {
            setProblem('Signing out failed. Reload and try again.');
          }
        })
      }
      className={cn(
        'flex items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors',
        problem ? 'text-destructive' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <LogOut className="size-3.5" aria-hidden />
      {problem ? <span className="text-xs">{problem}</span> : <span className="sr-only sm:not-sr-only">Sign out</span>}
    </button>
  );
}

