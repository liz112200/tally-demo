'use client';

import { useState } from 'react';
import { Check, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  absoluteShareUrl,
  buildShareSummary,
  type ShareLine,
} from '@/lib/share-summary';
import { createShareLink } from '@/app/_actions/share-links';

// Send the outstanding list to the person who owes it, using the device's own
// share sheet — Messages, WhatsApp, Messenger and the rest are whatever the OS
// offers. No SMS provider is involved: nothing leaves the device except
// through the sheet the user picks.
//
// The fallbacks matter because navigator.share is mobile-first: it is absent
// on most desktop browsers, and present-but-rejecting when the user dismisses
// the sheet. Order is share sheet -> sms: link -> clipboard.
export function ShareListButton({
  personName,
  owed,
  owing,
  groupBy,
  className,
}: {
  personName: string;
  // Both directions: a message listing only what someone owes, while
  // omitting what they are owed back, overstates the debt.
  owed: ShareLine[];
  owing: ShareLine[];
  groupBy: 'category' | null;
  className?: string;
}) {
  const [status, setStatus] = useState<
    'idle' | 'working' | 'copied' | 'failed'
  >('idle');

  // A list this size or smaller travels whole: the recipient reads it without
  // leaving their messages app, and no snapshot row is published for a list
  // that did not need one.
  const INLINE_LIMIT = 8;
  // Above it, the message carries a taste and defers to the page. Three lines
  // is enough to show what the list is without the message itself becoming
  // the wall of text the link exists to avoid.
  const TEASER_LINES = 3;

  const needsLink = owed.length + owing.length > INLINE_LIMIT;
  // What the message looks like with no link — also exactly what is sent when
  // the list is short. Used for the disabled check, which must not depend on
  // a link that has not been published yet.
  const text = buildShareSummary({ personName, owed, owing, groupBy });

  // navigator.share can hang: where the API exists but no share sheet can be
  // presented (automation, some embedded webviews, desktop builds without a
  // backend), the promise never settles — verified against headless Chrome,
  // which leaves the returned promise pending indefinitely rather than
  // rejecting. Awaiting it unguarded would leave a dead button with no
  // fallback, so the sheet is raced against a short timer.
  //
  // If the sheet does appear late, the user shares from it and the clipboard
  // copy is a harmless duplicate — the text is on the clipboard either way,
  // so the "Copied" label stays true.
  const SHEET_TIMEOUT_MS = 1200;

  async function copyToClipboard(message: string) {
    try {
      await navigator.clipboard.writeText(message);
      setStatus('copied');
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      // Clipboard denied (insecure context, or permission refused). Nothing
      // useful is left to try, so say so rather than failing silently.
      setStatus('failed');
      setTimeout(() => setStatus('idle'), 3000);
    }
  }

  async function onShare() {
    if (!text) return;

    // Publish the snapshot first: the link has to exist before it can go in
    // the message, and the share sheet must be opened from the same click,
    // so this await happens before any sheet is raised.
    let message = text;
    if (needsLink) {
      setStatus('working');
      const published = await createShareLink({
        personName,
        groupedByCategory: groupBy === 'category',
        owed,
        owing,
      });
      setStatus('idle');
      // If publishing fails, fall back to sending the list inline rather
      // than sending nothing — long is better than lost.
      message = published.ok
        ? buildShareSummary({
            personName,
            owed,
            owing,
            groupBy,
            limit: TEASER_LINES,
            // Snapshots are served by a separate Vercel project whose only
            // routes are /s/[token] and a dead end, so trimming a shared link
            // reveals no ledger. Falls back to this origin in local dev,
            // where the app still serves /s/ itself. absoluteShareUrl
            // supplies the scheme, which the dashboard-copied value omits.
            linkUrl: absoluteShareUrl(
              process.env.NEXT_PUBLIC_SHARE_BASE_URL || window.location.origin,
              published.token,
            ),
          })
        : text;
    }

    const canShare =
      typeof navigator !== 'undefined' &&
      typeof navigator.share === 'function' &&
      (typeof navigator.canShare !== 'function' ||
        navigator.canShare({ text: message }));

    if (canShare) {
      const settled = await Promise.race([
        navigator.share({ text: message }).then(
          () => 'shared' as const,
          // AbortError (the user dismissed the sheet) and NotAllowedError land
          // here alike. A dismissal is a deliberate "no", not a failure to
          // fall back from, so it ends the interaction.
          () => 'dismissed' as const,
        ),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), SHEET_TIMEOUT_MS),
        ),
      ]);
      if (settled !== 'timeout') return;
    }

    // Hand off to the SMS composer with the body prefilled. `&body=` after a
    // lone `?` is the form both iOS and Android accept.
    if (
      typeof window !== 'undefined' &&
      /Mobi|Android/i.test(navigator.userAgent)
    ) {
      window.location.href = `sms:?&body=${encodeURIComponent(message)}`;
      return;
    }

    await copyToClipboard(message);
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={onShare}
      disabled={!text || status === 'working'}
      title={
        text
          ? `Share where you stand with ${personName}`
          : 'Nothing outstanding to share'
      }
    >
      {status === 'working' ? (
        'Preparing…'
      ) : status === 'copied' ? (
        <>
          <Check data-icon="inline-start" />
          Copied
        </>
      ) : status === 'failed' ? (
        'Copy failed'
      ) : (
        <>
          <Share2 data-icon="inline-start" />
          Share
        </>
      )}
    </Button>
  );
}
