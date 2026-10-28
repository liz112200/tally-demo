'use client';

import { Suspense, useState, type ReactElement } from 'react';
import { Plus, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ImportForm } from '@/app/_components/import-form';
import { SampleImportButton } from '@/app/_components/sample-import';
import { AddTransactionForm } from '@/app/_components/add-transaction-form';

type Category = { id: string; name: string };

// Both flows live in dialogs so the transaction table stays the page's
// primary content. Dialog contents unmount on close, so each open starts
// from a clean form/preview state.

export function AddTransactionDialog({
  categories,
  trigger,
}: {
  categories: Category[];
  trigger: ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add transaction</DialogTitle>
          <DialogDescription>
            Enter a positive amount for spending, negative for a refund or
            credit.
          </DialogDescription>
        </DialogHeader>
        <AddTransactionForm
          categories={categories}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function ImportDialog({
  trigger,
}: {
  trigger: ReactElement<Record<string, unknown>>;
}) {
  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import bank CSV</DialogTitle>
          <DialogDescription>
            Chase, Discover, and Amex exports are detected automatically.
            Duplicates are skipped on confirm.
          </DialogDescription>
        </DialogHeader>
        <ImportForm />
      </DialogContent>
    </Dialog>
  );
}

// The standard toolbar triggers used in the page header on /.
export function ExpensesToolbar({
  categories,
  demo = false,
}: {
  categories: Category[];
  demo?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {demo && (
        // useSearchParams needs a Suspense boundary to prerender.
        <Suspense>
          <SampleImportButton />
        </Suspense>
      )}
      <ImportDialog
        trigger={
          <Button variant="outline" size="sm">
            <Upload data-icon="inline-start" />
            Import
          </Button>
        }
      />
      <AddTransactionDialog
        categories={categories}
        trigger={
          <Button size="sm">
            <Plus data-icon="inline-start" />
            Add
          </Button>
        }
      />
    </div>
  );
}
