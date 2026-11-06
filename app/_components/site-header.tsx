'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { signOut } from '@/app/_actions/auth';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/app/_components/theme-toggle';
import { navActive, navFor } from '@/lib/nav';

// Wordmark glyph: four tally strokes and the diagonal fifth, in brass.
function TallyMark() {
  return (
    <svg
      viewBox="0 0 20 16"
      aria-hidden
      className="h-4 w-5 text-primary"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M2.5 2.5v11M7.5 2.5v11M12.5 2.5v11M17.5 2.5v11" />
      <path d="M0.5 11.5 19.5 4.5" />
    </svg>
  );
}

// `demo` comes from the server-rendered layout rather than useIsDemo, which is
// false until mount: links hidden in the demo must be absent from the first
// paint, not removed after hydration.
export function SiteHeader({ demo }: { demo: boolean }) {
  const pathname = usePathname();
  // A published share snapshot (/s/<token>) is read by someone who is not
  // the owner and has no access to the app: showing them app navigation
  // would offer links they cannot use and imply the ledger is theirs.
  if (pathname.startsWith('/s/')) return null;
  // Signing in has nowhere to navigate to yet.
  if (pathname === '/sign-in') return null;
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link href="/" aria-label="tally, home" className="flex shrink-0 items-center gap-2">
          <TallyMark />
          <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">
            tally
          </span>
        </Link>
        {/* One row always (the table's sticky headers sit under it): on a
            phone the items scroll sideways rather than wrap. */}
        <nav className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm [scrollbar-width:none]">
          {navFor(demo).map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1 transition-colors',
                navActive(href, pathname)
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!demo && <SignOutButton />}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
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

