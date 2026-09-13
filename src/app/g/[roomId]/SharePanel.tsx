'use client';

/**
 * The share panel (GDD §5.1, §6.3): the link, a **Copy** button whose text
 * changes to "Copied" for 1.5 s, and the Web Share API where the browser has it.
 *
 * It lives in the bottom bar (§6.1), open by default while the room is waiting
 * for its second player and collapsible thereafter — the link is still worth
 * having once the game is under way, since anyone else who opens it can watch
 * (§6.4), but the board wants the space at 360 px.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BUTTON_CLASS } from './ui';

const COPIED_MS = 1_500;

/** These two facts about the browser never change while the page is open. */
const NEVER_CHANGES = () => () => {};
const pageUrl = () => window.location.href;
const hasWebShare = () => typeof navigator.share === 'function';

export interface SharePanelProps {
  /** The room has one player in it: the link is what it is waiting for. */
  waiting: boolean;
}

export function SharePanel({ waiting }: SharePanelProps) {
  // The origin is the browser's, not the server's, so both of these are empty
  // in the server render and fill in on hydration.
  const url = useSyncExternalStore(NEVER_CHANGES, pageUrl, () => '');
  const canShare = useSyncExternalStore(NEVER_CHANGES, hasWebShare, () => false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // No clipboard permission: the link is on screen to select by hand.
      return;
    }
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  async function share() {
    try {
      await navigator.share({ title: 'Morris', url });
    } catch {
      // Cancelled, or refused. Nothing to say (§6.2).
    }
  }

  return (
    <section
      data-testid="share"
      className="flex w-full flex-col gap-2 rounded-xl border border-black/20 bg-white px-3 py-2"
    >
      {/* The status bar carries "Waiting for an opponent…" (§6.2), so this
          says what to *do* about it rather than repeating it. */}
      <p className="text-sm font-semibold">
        {waiting ? 'Send this link' : 'Share this game'}
      </p>
      <p className="text-xs text-black/60">
        {waiting
          ? 'The first person to open it plays Black.'
          : 'Both seats are taken. Anyone else who opens this link can watch.'}
      </p>
      {/* A tap target, not just a label: it selects itself on focus, and the
          copy-failure path above asks the player to do exactly that. So it
          carries the same 44 px floor as every other control (§6.2). */}
      <input
        readOnly
        value={url}
        aria-label="Game link"
        data-testid="share-link"
        onFocus={(event) => event.currentTarget.select()}
        className="min-h-11 w-full truncate rounded-lg border border-black/15 bg-black/5 px-2 text-xs"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          data-testid="copy"
          className={BUTTON_CLASS}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {canShare && (
          <button
            type="button"
            onClick={() => void share()}
            data-testid="share-native"
            className={BUTTON_CLASS}
          >
            Share
          </button>
        )}
      </div>
    </section>
  );
}
