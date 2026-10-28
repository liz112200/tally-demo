'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ImportForm } from '@/app/_components/import-form';

// Demo only: one click fetches the bundled sample statement and opens the real
// import flow on it (preview -> confirm), so a visitor needs no CSV of their
// own. Also opened by the orientation strip's ?demo=sample-import link.
export function SampleImportButton() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/demo/sample-statement', { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      const name =
        res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ??
        'sample-statement.csv';
      setFile(new File([await res.blob()], name, { type: 'text/csv' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the sample');
    } finally {
      setLoading(false);
    }
  }

  // Arriving from the orientation strip: open once, then drop the param so a
  // reload does not reopen it.
  const fromStrip = searchParams.get('demo') === 'sample-import';
  useEffect(() => {
    if (!fromStrip) return;
    router.replace('/', { scroll: false });
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromStrip]);

  return (
    <>
      <Button variant="outline" size="sm" onClick={open} disabled={loading}>
        <FileSpreadsheet data-icon="inline-start" />
        {loading ? 'Loading…' : 'Import a sample statement'}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Dialog open={file !== null} onOpenChange={(o) => !o && setFile(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import a sample statement</DialogTitle>
            <DialogDescription>
              A synthetic Discover statement covering the last two weeks. Its
              oldest rows were already imported, so the preview flags them as
              duplicates; rules categorize the rest. Import it again and every
              row is a duplicate.
            </DialogDescription>
          </DialogHeader>
          {file && <ImportForm key={file.name + file.size} initialFile={file} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
