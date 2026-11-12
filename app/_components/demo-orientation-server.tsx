import { demoUnverifiedAccountId } from '@/db/demo-bank';
import { DemoOrientation } from './demo-orientation';

// The first-visit strip, with its statement-check link pointing at the demo
// account still awaiting one. Rendered only in demo mode (app/layout.tsx),
// so production never runs the lookup.
export async function DemoOrientationStrip({ dismissed }: { dismissed: boolean }) {
  const id = await demoUnverifiedAccountId();
  return <DemoOrientation verifyHref={id ? `/accounts/verify/${id}` : '/accounts'} dismissed={dismissed} />;
}
