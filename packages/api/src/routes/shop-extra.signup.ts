/** One subscriber/outbox transaction for canonical signup & bounded compatibility adapters. */
import { and, eq, gt, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { sendSubscriberConfirmation } from './shop-extra.subscriber.js';

export interface SubscriberSignupInput {
  email: string;
  name?: string;
  kind?: 'newsletter' | 'waitlist';
  topic?: string;
  source?: 'storefront' | 'checkout' | 'import' | 'api';
  meta?: Record<string, unknown>;
  initialMeta?: Record<string, unknown>;
}

/** Internal trusted adapter seam. Import is inert; legacy duplicates preserve every consent state. */
export async function persistSubscriberSignup(
  st: { id: string; name: string; currency: string },
  input: SubscriberSignupInput,
  mode: 'canonical' | 'legacy' | 'import' = 'canonical',
): Promise<{ existed: boolean; enqueued: boolean }> {
  const { email, name, kind = 'newsletter', topic = '', source = 'storefront', meta, initialMeta } = input;
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedTopic = topic;
  const CONFIRM_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
  // B2.16: the cooldown used to be per (address, kind, topic), and `topic` is free text — varying it created a new
  // row (and a new confirmation e-mail) on every request. Confirmations are now also capped per ADDRESS across all
  // kinds/topics, serialized per (store, address) so concurrent requests cannot all pass the check.
  const ADDRESS_MAX_CONFIRMS_PER_COOLDOWN = 3;
  return withStore(st.id, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'subscriber-confirm:' + st.id + ':' + normalizedEmail}, 0))`);
    const [recent] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.subscriber)
      .where(and(eq(s.subscriber.storeId, st.id), eq(s.subscriber.email, normalizedEmail), gt(s.subscriber.lastSentAt, new Date(Date.now() - CONFIRM_COOLDOWN_MS))));
    const addressCapped = (recent?.n ?? 0) >= ADDRESS_MAX_CONFIRMS_PER_COOLDOWN;
    const [existing] = await tx
      .select({
        id: s.subscriber.id,
        status: s.subscriber.status,
        token: s.subscriber.token,
        lastSentAt: s.subscriber.lastSentAt,
        meta: s.subscriber.meta,
      })
      .from(s.subscriber)
      .where(and(
        eq(s.subscriber.storeId, st.id),
        eq(s.subscriber.email, normalizedEmail),
        eq(s.subscriber.kind, kind),
        eq(s.subscriber.topic, normalizedTopic),
      ))
      .limit(1);

    const now = new Date();
    const inert = mode === 'import';
    if (!existing) {
      const [row] = await tx.insert(s.subscriber).values({
        storeId: st.id,
        email: normalizedEmail,
        name: name ?? null,
        kind,
        topic: normalizedTopic,
        status: 'pending',
        source,
        meta: initialMeta || meta ? { ...initialMeta, ...meta } : null,
        lastSentAt: inert || addressCapped ? null : now,
      })
        // The SELECT above is not atomic with this INSERT: two concurrent
        // signups for the same (store, email, kind, topic) both see no row
        // and both insert, and the loser violates
        // `subscriber_store_email_kind_topic_key`. A double-clicked subscribe
        // button is enough to hit it — the per-IP throttle allows 5 attempts
        // per 15 min, so it does not serialize them. onConflictDoNothing
        // turns that 500 into the correct outcome: the winner created the row
        // and enqueued the confirmation, so the loser is a no-op and no
        // second email goes out (the mailbomb guard holds under races too).
        .onConflictDoNothing()
        .returning({ id: s.subscriber.id, token: s.subscriber.token });
      if (!row) return { existed: true, enqueued: false }; // lost the insert race — winner already enqueued.
      if (inert || addressCapped) return { existed: false, enqueued: false }; // row kept (pending), no e-mail: this address hit its per-hour cap
      await sendSubscriberConfirmation(tx, st, { email: normalizedEmail, name: name ?? null, kind, topic: normalizedTopic, token: row.token });
      return { existed: false, enqueued: true };
    }

    // Compatibility duplicates & imports cannot revive consent or send mail.
    if (mode !== 'canonical') {
      const prior = existing.meta && typeof existing.meta === 'object' && !Array.isArray(existing.meta)
        ? existing.meta as Record<string, unknown> : {};
      await tx.update(s.subscriber).set({
        meta: meta ? (inert ? { ...meta, ...prior } : { ...prior, ...meta }) : prior,
        updatedAt: now,
      }).where(eq(s.subscriber.id, existing.id));
      return { existed: true, enqueued: false };
    }

    if (existing.status === 'confirmed') {
      // No-op, no email. Do not leak that they're already on the list.
      return { existed: true, enqueued: false };
    }

    // Cooldown vs re-consent precedence. The cooldown exists to stop an
    // attacker mailbombing a victim by replaying signup for their address —
    // that attack drives the row pending → pending, which IS rate-limited
    // below. Reaching `unsubscribed` requires the capability token, which
    // only ever went to the address owner, so an unsubscribed → pending
    // re-consent is necessarily user-initiated and is exempt: someone who
    // unsubscribes by accident and immediately resubscribes must not be met
    // with silence (they would just retry, and never land on the list). The
    // residual abuse is one extra email per unsubscribe the victim performs,
    // which is bounded by a victim action each time.
    // The cooldown gates the EMAIL, never the row update. A legitimate repeat
    // signup can carry new data — a multi-step form posts the address first
    // and survey answers second, seconds apart — and returning early here
    // would silently discard that `meta`/`name`/`source` while still
    // reporting {ok:true}. Update the row unconditionally, then decide
    // whether an email is due.
    const isReconsent = existing.status === 'unsubscribed';
    const lastSent = existing.lastSentAt?.getTime() ?? 0;
    const withinCooldown = !isReconsent && (now.getTime() - lastSent < CONFIRM_COOLDOWN_MS || addressCapped);

    // Flip unsubscribed back to pending; clear unsubscribed_at. `last_sent_at`
    // only moves when we actually send, otherwise a burst of repeat posts
    // would keep pushing the cooldown window forward and starve the send.
    // Re-use the existing token so unsubscribe links from prior emails stay
    // valid; rotate on confirmed→pending if needed (none here).
    const nextStatus = existing.status === 'unsubscribed' ? 'pending' : existing.status;
    await tx.update(s.subscriber)
      .set({
        status: nextStatus,
        unsubscribedAt: null,
        ...(withinCooldown ? {} : { lastSentAt: now }),
        // Re-record the source on every signup attempt — useful when an
        // address resubscribes from a different surface (e.g. they
        // originally came in via 'checkout', now from 'storefront').
        source,
        meta: meta ?? undefined,
        updatedAt: now,
      })
      .where(eq(s.subscriber.id, existing.id));
    // Row is updated either way; the email is what the cooldown suppresses.
    if (withinCooldown) return { existed: true, enqueued: false };
    await sendSubscriberConfirmation(tx, st, { email: normalizedEmail, name: name ?? null, kind, topic: normalizedTopic, token: existing.token });
    return { existed: true, enqueued: true };
  });

}
