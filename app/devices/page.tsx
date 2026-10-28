import { activeSessions, getUserPasskeys } from '@/db/auth';
import { deviceLabel } from '@/lib/auth/device-label';
import { passkeyWhere } from '@/lib/auth/passkey-provider';
import { isDemoMode } from '@/lib/demo-mode';
import { requireUser } from '@/app/_lib/session';
import { AddDeviceButton, RevokeSessionButton } from '@/app/_components/devices';

export const metadata = { title: 'Devices · tally' };
export const dynamic = 'force-dynamic';

function formatWhen(date: Date): string {
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
}

// Where the owner is signed in, and with which passkeys (AUTH.md).
export default async function DevicesPage() {
  const user = await requireUser();
  if (isDemoMode()) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="text-xl font-semibold tracking-tight">Devices</h1>
        <p className="mt-2 text-sm text-muted-foreground">The demo has no sign-in.</p>
      </main>
    );
  }
  const [passkeys, sessions] = await Promise.all([getUserPasskeys(user.id), activeSessions(user.id)]);
  return (
    <main className="mx-auto max-w-4xl space-y-8 px-6 py-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Devices</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Signed in as {user.displayName}.</p>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium">Passkeys</h2>
          <AddDeviceButton />
        </div>
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {passkeys.map((p) => (
            <li key={p.id} className="px-4 py-2 text-sm">
              {p.deviceLabel}
              <div className="text-xs text-muted-foreground">{passkeyWhere(p)}</div>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          A passkey belongs to this site&apos;s address and to the password manager that made it: one made in Chrome is
          not offered by Safari, and the other way round. If the app moves to another domain, every passkey is made
          again with the setup token.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Signed in</h2>
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-2 text-sm">
              <div>
                {deviceLabel(s.userAgent)}
                <div className="text-xs text-muted-foreground">
                  since {formatWhen(s.createdAt)} · last seen {formatWhen(s.lastSeenAt)}
                </div>
              </div>
              {s.id === user.sessionId ? (
                <span className="text-xs text-muted-foreground">this device</span>
              ) : (
                <RevokeSessionButton sessionId={s.id} />
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
