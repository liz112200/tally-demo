import 'server-only';

import { headers } from 'next/headers';
import { isDemoMode } from '@/lib/demo-mode';
import { billViewerOrigin } from '@/lib/share-summary';

// The demo and an unconfigured local development server host their own viewer.
// Personal links always use the configured viewer, even on a deployment alias.
export async function getBillLinkBase(): Promise<string | null> {
  const configured = process.env.NEXT_PUBLIC_SHARE_BASE_URL;
  const development = process.env.NODE_ENV === 'development';
  if (isDemoMode() || (development && !configured)) return '';

  const host = (await headers()).get('host');
  return billViewerOrigin(configured, [host, process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL], development);
}
