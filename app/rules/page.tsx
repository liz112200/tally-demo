import { redirect } from 'next/navigation';
import { requireUser } from '@/app/_lib/session';

// Categories and rules are a section of Settings (2026-11-05).
export default async function RulesRedirect() {
  await requireUser();
  redirect('/settings#rules');
}
