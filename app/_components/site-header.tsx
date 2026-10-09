'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/app/_components/theme-toggle';

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

const NAV = [
  { href: '/', label: 'Expenses' },
  { href: '/insights', label: 'Insights' },
  { href: '/people', label: 'People' },
  { href: '/rules', label: 'Rules' },
] as const;

export function SiteHeader() {
  const pathname = usePathname();
  // A published share snapshot (/s/<token>) is read by someone who is not
  // the owner and has no access to the app: showing them app navigation
  // would offer links they cannot use and imply the ledger is theirs.
  if (pathname.startsWith('/s/')) return null;
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-6xl items-center gap-6 px-6">
        <Link href="/" className="flex items-center gap-2">
          <TallyMark />
          <span className="text-[15px] font-semibold tracking-tight">
            tally
          </span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {NAV.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'rounded-md px-2.5 py-1 transition-colors',
                pathname === href
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
