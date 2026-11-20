'use client';

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';

const palettes = [
  ['carbon', 'Carbon', 'Black & silver · default'],
  ['graphite', 'Graphite', 'Neutral charcoal · silver'],
  ['ink', 'Ink', 'Near-black · white'],
  ['slate', 'Slate', 'Cool gray · ice blue'],
  ['cinder', 'Cinder', 'Warm black · sand'],
  ['pine', 'Pine', 'Green charcoal · mint'],
] as const;

export function DarkPalettes() {
  const [active, setActive] = useState('');
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const saved = palettes.find(([id]) => id === root.dataset.darkPalette);
      setActive(root.classList.contains('dark') ? (saved ?? palettes[0])[0] : '');
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-dark-palette'] });
    return () => observer.disconnect();
  }, []);

  function choose(id: string) {
    document.documentElement.dataset.darkPalette = id;
    document.documentElement.classList.add('dark');
    try {
      localStorage.setItem('ledger-dark-palette', id);
      localStorage.setItem('theme', 'dark');
    } catch { /* The preview still works for this visit. */ }
  }

  return <section id="appearance" aria-labelledby="appearance-heading" className="space-y-3">
    <div>
      <h2 id="appearance-heading" className="text-lg font-semibold tracking-tight">Appearance</h2>
      <p className="text-sm text-muted-foreground">Choose a palette for dark mode.</p>
    </div>
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(9.5rem,100%),1fr))] gap-2">
      {palettes.map(([id, name, description]) => (
        <button key={id} type="button" onClick={() => choose(id)} aria-pressed={active === id}
          className="overflow-hidden rounded-lg border bg-card text-left hover:border-foreground/50 aria-pressed:border-primary">
          <span className="palette-preview" aria-hidden data-dark-palette={id}><i /><b /><em /></span>
          <span className="block p-2.5">
            <span className="flex items-center justify-between text-sm font-semibold">{name}{active === id && <Check aria-hidden className="size-4" />}</span>
            <span className="text-xs text-muted-foreground">{description}</span>
          </span>
        </button>
      ))}
    </div>
  </section>;
}
