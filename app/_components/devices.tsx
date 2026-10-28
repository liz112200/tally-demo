'use client';

import { startRegistration } from '@simplewebauthn/browser';
import { KeyRound, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { beginAddDevice, finishAddDevice, revokeOtherSession } from '@/app/_actions/auth';
import { useAction } from './page-result';

// Adds a passkey on this device for the signed-in user. A device whose
// platform already syncs one of the user's passkeys is not offered another
// (excludeCredentials); the browser says so in its own prompt.
export function AddDeviceButton() {
  const { run, pending } = useAction();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        run(async () => {
          const begun = await beginAddDevice();
          if ('error' in begun) return begun;
          let answer;
          try {
            answer = await startRegistration({ optionsJSON: begun.options });
          } catch (err) {
            return {
              error:
                err instanceof Error && err.name === 'InvalidStateError'
                  ? 'This device already holds a passkey for you.'
                  : err instanceof Error && err.name === 'NotAllowedError'
                    ? 'The passkey prompt was closed. Nothing was added.'
                    : 'This browser could not create a passkey here.',
            };
          }
          return finishAddDevice(begun.challengeId, answer);
        })
      }
    >
      <KeyRound data-icon="inline-start" />
      {pending ? 'Adding…' : 'Add a passkey on this device'}
    </Button>
  );
}

export function RevokeSessionButton({ sessionId }: { sessionId: string }) {
  const { run, pending } = useAction();
  return (
    <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => revokeOtherSession(sessionId))}>
      <LogOut data-icon="inline-start" />
      {pending ? 'Signing out…' : 'Sign out there'}
    </Button>
  );
}
