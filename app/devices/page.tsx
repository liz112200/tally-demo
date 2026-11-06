import { redirect } from 'next/navigation';
import { requireUser } from '@/app/_lib/session';

// Devices are a section of Settings (2026-11-05).
export default async function DevicesRedirect() {
  await requireUser();
  redirect('/settings#devices');
}
