'use client';

import { useState } from 'react';
import { useIsDemo } from '@/app/_lib/use-demo';
import { BillDesignPicker } from './bill-design-picker';
import { demoSharingNote, type BillDesign } from '@/lib/bill-design';
import { Check, Link2, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  absoluteShareUrl,
  sumLines,
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
  const demo = useIsDemo();
  const [status, setStatus] = useState<
    'idle' | 'working' | 'copied' | 'failed' | 'publishFailed'
  >('idle');

  // A list this size or smaller travels whole: the recipient reads it without
  // leaving their messages app, and no snapshot row is published for a list
  // that did not need one.
  const INLINE_LIMIT = 8;
  // Above it, the message carries a taste and defers to the page. Three lines
  // is enough to show what the list is without the message itself becoming
  // the wall of text the link exists to avoid.
  const TEASER_LINES = 3;

  const [design, setDesign] = useState<BillDesign>('classic');
  const needsLink = owed.length + owing.length > INLINE_LIMIT || design !== 'classic';
  // What the message looks like with no link — also exactly what is sent when
  // the list is short. Used for the disabled check, which must not depend on
  // a link that has not been published yet.
  const text = buildShareSummary({ personName, owed, owing, groupBy, guestCheck: true });

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

  // Publish this list as a snapshot and return its address, or null when
  // publishing failed. Snapshots are served by a separate Vercel project
  // whose only routes are /s/[token] and a dead end, so trimming a shared
  // link reveals no ledger. Falls back to this origin in local dev, where the
  // app still serves /s/ itself. absoluteShareUrl supplies the scheme, which
  // the dashboard-copied value omits.
  async function publishLink(): Promise<string | null> {
    try {
      const base = demo ? window.location.origin : process.env.NEXT_PUBLIC_SHARE_BASE_URL
        || (process.env.NODE_ENV === 'development' ? window.location.origin : undefined);
      if (!base) return null;
      const origin = new URL(absoluteShareUrl(base, 'bill')).origin;
      if (!demo && process.env.NODE_ENV === 'production' && origin === window.location.origin) return null;
      const published = await createShareLink({
        personName,
        paper: design,
        groupedByCategory: groupBy === 'category',
        owed,
        owing,
      });
      return published.ok ? absoluteShareUrl(base, published.token) : null;
    } catch {
      return null;
    }
  }

  // The link on its own, whatever the list's length: for a short list the
  // owner would rather send as a page than as text.
  const [linkStatus, setLinkStatus] = useState<'idle' | 'working' | 'copied' | 'failed'>('idle');
  async function onCopyLink() {
    if (!text) return;
    setLinkStatus('working');
    const url = await publishLink();
    try {
      if (!url) throw new Error('not published');
      await navigator.clipboard.writeText(url);
      setLinkStatus('copied');
    } catch {
      setLinkStatus('failed');
    }
    setTimeout(() => setLinkStatus('idle'), 2500);
  }

  async function onShare() {
    if (!text) return;

    // Publish the snapshot first: the link has to exist before it can go in
    // the message, and the share sheet must be opened from the same click,
    // so this await happens before any sheet is raised.
    let message = text;
    if (needsLink) {
      setStatus('working');
      const url = await publishLink();
      if (!url && design !== 'classic') {
        setStatus('publishFailed');
        return;
      }
      setStatus('idle');
      // If publishing fails, fall back to sending the list inline rather
      // than sending nothing — long is better than lost.
      message = url
        ? buildShareSummary({ personName, owed, owing, groupBy, guestCheck: true, limit: TEASER_LINES, linkUrl: url })
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
    <span className={cn('inline-flex gap-1', className, 'h-auto w-full flex-wrap items-center justify-end')}>
      {text && <BillDesignPicker design={design} onChange={setDesign} name={personName} net={sumLines(owed) - sumLines(owing)} />}
      <Button
        type="button"
        variant="outline"
        size="sm"
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
        ) : status === 'publishFailed' ? (
          'Couldn’t create link · Retry'
        ) : status === 'failed' ? (
          'Copy failed'
        ) : (
          <>
            <Share2 data-icon="inline-start" />
            Share
          </>
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onCopyLink}
        disabled={!text || linkStatus === 'working'}
        title={text ? `Publish where you stand with ${personName} as a page, and copy its link` : 'Nothing outstanding to share'}
      >
        {linkStatus === 'working' ? (
          'Publishing…'
        ) : linkStatus === 'copied' ? (
          <>
            <Check data-icon="inline-start" />
            Link copied
          </>
        ) : linkStatus === 'failed' ? (
          'Link failed'
        ) : (
          <>
            <Link2 data-icon="inline-start" />
            Copy link
          </>
        )}
      </Button>
      {text && <small className="w-full text-right text-xs text-muted-foreground">{demo ? demoSharingNote : 'This link opens only the shared bill on a separate site.'}</small>}
    </span>
  );
}
