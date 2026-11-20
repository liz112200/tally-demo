'use client';

import { Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { billDesigns, guestCopy, type BillDesign } from '@/lib/bill-design';
import { guestCheckBalance } from '@/lib/share-summary';

export function BillDesignPicker({ design, onChange, name, net }: {
  design: BillDesign;
  onChange: (value: BillDesign) => void;
  name: string;
  net: number;
}) {
  return <Dialog>
    <DialogTrigger render={<Button variant="outline" size="sm" />}>
      <Palette aria-hidden /> Bill style
    </DialogTrigger>
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogTitle>Choose bill paper</DialogTitle>
      <div className="bill-proof bill-paper" data-paper={design} aria-label="Bill preview">
        <div className="bill-proof-body">
          <span className="guest-stamp">Guest check</span>
          <h3>{guestCopy.heading(name)}</h3>
          <p>Total: <strong>{guestCheckBalance(net)} <small>{guestCopy.balance(net)}</small></strong></p>
        </div>
      </div>
      <fieldset className="bill-swatches">
        <legend className="sr-only">Paper pattern</legend>
        {(Object.keys(billDesigns) as BillDesign[]).map(key => <label key={key}>
          <input type="radio" name="bill-paper" checked={design === key} onChange={() => onChange(key)} />
          <span>{billDesigns[key]}</span>
        </label>)}
      </fieldset>
      <DialogClose render={<Button />}>Done</DialogClose>
    </DialogContent>
  </Dialog>;
}
