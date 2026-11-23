// Ledger forms and month-to-date reports follow the owner's calendar day.
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

export function ownerToday() {
  return dayFormat.format(new Date());
}
