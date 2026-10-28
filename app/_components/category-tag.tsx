import { Zap } from 'lucide-react';

// categories.color is unpopulated in v1, so each category gets a stable hue
// derived from its name: djb2 hash into the eight --cat-* variables defined in
// globals.css (which carry separate light/dark values).
export function categoryColorVar(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  }
  return `var(--cat-${((h % 8) + 8) % 8})`;
}

// Category provenance rendering: rule-applied categories are a tinted tag with
// a zap glyph; manually set ones are plain text with a colored dot. This
// replaces the earlier hollow/filled source dot.
export function CategoryTag({
  name,
  source,
}: {
  name: string;
  source: 'manual' | 'rule' | null;
}) {
  const color = categoryColorVar(name);
  if (source === 'rule') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium"
        style={{
          color,
          backgroundColor: `color-mix(in oklch, ${color} 13%, transparent)`,
        }}
        title="Category set by a rule"
      >
        <Zap className="size-3" aria-hidden />
        {name}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={source === 'manual' ? 'Category set manually' : undefined}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      {name}
    </span>
  );
}
