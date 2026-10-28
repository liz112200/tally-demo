'use client';

import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Both icons are always rendered and CSS decides which shows, so the server
// markup never depends on the theme and there is no hydration mismatch.
export function ThemeToggle() {
  function toggle() {
    const dark = document.documentElement.classList.toggle('dark');
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light');
    } catch {
      // Ignore storage failures; the class still applies for this visit.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={toggle}
      aria-label="Toggle theme"
    >
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  );
}
