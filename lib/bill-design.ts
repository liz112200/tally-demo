export const billDesigns = {
  classic: 'Classic',
  flowers: 'Wildflowers',
  paws: 'Paw prints',
  citrus: 'Citrus slices',
  koi: 'Koi pond',
  postage: 'Postage stamps',
  'night-sky': 'Night sky',
  gingham: 'Picnic gingham',
  coffee: 'Coffee break',
  waves: 'Ocean waves',
  cranes: 'Paper cranes',
  berries: 'Strawberry patch',
  vinyl: 'Vinyl records',
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

export const demoSharingNote = 'Demo bills open here on tally-demo-one.vercel.app. Bills from the personal app open on a separate site, share-snowy-seven.vercel.app. Each link shows only the shared bill.';
