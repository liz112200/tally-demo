import { redirect } from 'next/navigation';
import { requireUser } from '@/app/_lib/session';

// The accounts board is the home page (2026-11-05); old links land on it.
export default async function AccountsRedirect() {
  await requireUser();
  redirect('/');
}
