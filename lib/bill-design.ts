export const billDesigns = {
  classic: 'Classic',
  flowers: 'Wildflowers',
  paws: 'Paw prints',
} as const;

export type BillDesign = keyof typeof billDesigns;

export function readBillDesign(value: unknown): BillDesign {
  return typeof value === 'string' && Object.hasOwn(billDesigns, value)
    ? value as BillDesign
    : 'classic';
}

export const guestCopy = {
  heading: (name: string) => `Our tab, ${name}`,
  coveredByMe: 'What I paid',
  coveredByYou: 'What you paid',
  balance: (net: number) => net > 0 ? 'to me' : net < 0 ? 'to you' : 'settled',
};

export const demoSharingNote = 'Demo bills open on this site. The personal app shares each bill on a separate, read-only site with no access to the private ledger.';
