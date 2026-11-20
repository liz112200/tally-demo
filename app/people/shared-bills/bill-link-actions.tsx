'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/app/_components/confirm-dialog';
import { useAction } from '@/app/_components/page-result';
import { turnOffBillLink } from '@/app/_actions/share-links';

export function BillLinkActions({ id, token, personName }: {
  id: string; token: string; personName: string;
}) {
  const { run, pending } = useAction();
  const path = '/s/' + encodeURIComponent(token);

  function copy() {
    run(async () => {
      try {
        await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
        return { ok: true, message: 'Bill link copied.' };
      } catch {
        return { error: 'Open the bill to copy its address from your browser.' };
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={path} target="_blank" rel="noopener noreferrer" className="py-1 text-sm font-medium underline underline-offset-4">Open bill</a>
      <Button size="sm" variant="outline" disabled={pending} onClick={copy}>Copy link</Button>
      <ConfirmDialog
        trigger={<Button size="sm" variant="ghost" className="text-muted-foreground">Turn off link</Button>}
        title="Turn off this link?"
        description={`Anyone using this link to view the bill for ${personName} will lose access. You can still create a new link from People.`}
        confirmLabel="Turn off link"
        onConfirm={() => turnOffBillLink(id)}
      />
    </div>
  );
}
