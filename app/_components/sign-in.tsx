'use client';

import { useState, useTransition } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { beginBootstrap, beginSignIn, finishBootstrap, finishSignIn } from '@/app/_actions/auth';

// The browser reports a dismissed prompt and "this device has no passkey for
// this site" the same way (NotAllowedError), so the message covers both.
function promptProblem(err: unknown, signingIn: boolean): string {
  if (err instanceof Error && err.name === 'NotAllowedError') {
    return signingIn
      ? 'No passkey was used. If this device has none for Tally, add one from a signed-in device, under Devices.'
      : 'The passkey prompt was closed. Nothing was created.';
  }
  return 'This browser could not use a passkey here.';
}

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  );
}

export function SignInButton({ next }: { next: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-3">
      <Button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setProblem(null);
            const begun = await beginSignIn();
            if ('error' in begun) return setProblem(begun.error);
            let answer;
            try {
              answer = await startAuthentication({ optionsJSON: begun.options });
            } catch (err) {
              return setProblem(promptProblem(err, true));
            }
            // On success the action navigates; only a refusal comes back.
            const result = await finishSignIn(begun.challengeId, answer, next);
            if ('error' in result) setProblem(result.error);
          })
        }
      >
        <KeyRound data-icon="inline-start" />
        {pending ? 'Signing in…' : 'Sign in with a passkey'}
      </Button>
      <Problem text={problem} />
    </div>
  );
}

// The first passkey, once, with the token the owner set in Vercel.
export function BootstrapForm() {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="grid max-w-sm gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          setProblem(null);
          const begun = await beginBootstrap(token);
          if ('error' in begun) return setProblem(begun.error);
          let answer;
          try {
            answer = await startRegistration({ optionsJSON: begun.options });
          } catch (err) {
            return setProblem(promptProblem(err, false));
          }
          const result = await finishBootstrap(begun.challengeId, answer, name);
          if ('error' in result) setProblem(result.error);
        });
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="bootstrap-name">Your name</Label>
        <Input id="bootstrap-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="bootstrap-token">Setup token</Label>
        <Input
          id="bootstrap-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">AUTH_BOOTSTRAP_TOKEN, as set in Vercel. It works once.</p>
      </div>
      <Button type="submit" disabled={pending || !name.trim() || !token}>
        <KeyRound data-icon="inline-start" />
        {pending ? 'Creating passkey…' : 'Create my passkey'}
      </Button>
      <Problem text={problem} />
    </form>
  );
}
