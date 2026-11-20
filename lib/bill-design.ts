export const billDesigns = {
  classic: 'Classic',
  flowers: 'Wildflowers',
  paws: 'Paw prints',
  chiikawa: 'Chiikawa',
} as const;

export type BillDesign = keyof typeof billDesigns;

export function readBillDesign(value: unknown): BillDesign {
  return typeof value === 'string' && Object.hasOwn(billDesigns, value)
    ? value as BillDesign
    : 'classic';
}

export const guestCopy = {
  heading: (name: string) => `Our tab, ${name}`,
  coveredByMe: 'I picked these up for you',
  coveredByYou: 'You picked these up for me',
  balance: (net: number) => net > 0 ? 'To send my way' : net < 0 ? 'Coming your way' : 'All square!',
};
