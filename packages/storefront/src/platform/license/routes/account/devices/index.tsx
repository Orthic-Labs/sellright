import { component$, useStore, useVisibleTask$, $ } from '@qwik.dev/core';
import { type DocumentHead, type RequestHandler } from '@qwik.dev/router';
import { BRAND_LICENSE } from '~/platform/brand-data';
import { variantByKey } from '~/platform/host-variant';
import { myDevices, renameDevice, removeDevice, type Device } from '../../../api';
import { useHostVariant } from '../../layout';

/** Only when src/brand/license.json declares the devices feature (its API plugin endpoint). */
export const onGet: RequestHandler = ({ error }) => {
  if (!BRAND_LICENSE?.devices) throw error(404, 'Not found');
};

const fmtDateTime = (s: string | null) => (s ? new Date(s).toLocaleString() : 'never seen');

// Canonical pool caps: two computer slots pooled across
// macOS + Windows, two mobile slots across iPhone + iPad, Watch companion
// with no seat of its own. `seats <= 0` on the underlying license means
// grandfathered/unlimited — never render that as "2 of 2".
const POOL_LABEL: Record<string, string> = {
  computer: 'Computer (macOS + Windows)',
  mobile: 'Mobile (iPhone + iPad)',
  watch: 'Watch companion',
};
const POOL_CAP: Record<string, number> = { computer: 2, mobile: 2, watch: Infinity };

const PLATFORM_LABEL: Record<string, string> = {
  macos: 'macOS', windows: 'Windows', ios: 'iPhone', ipados: 'iPad', watchos: 'Watch',
};

interface DevicesState {
  loggedIn: boolean;
  devices: Device[];
  loaded: boolean;
  error: string;
  /** Device id currently mid-action, or ''. */
  busy: string;
  renamingId: string;
  renameValue: string;
  confirmRemoveId: string;
}

export default component$(() => {
  const store = useHostVariant();
  const st = useStore<DevicesState>({
    // no client-held bearer — the sr_cust httpOnly cookie carries the
    // session; `loggedIn` only reflects whether the cookie-authenticated
    // load succeeded.
    loggedIn: false,
    devices: [] as Device[],
    loaded: false,
    error: '',
    busy: '' as string, // device id currently mid-action, or ''
    renamingId: '' as string,
    renameValue: '',
    confirmRemoveId: '' as string,
  });

  const load = $(async () => {
    try {
      const res = await myDevices();
      st.devices = res.items;
      st.loggedIn = true;
    } catch (e) {
      st.loggedIn = false;
      const status = (e as Error & { status?: number }).status;
      if (status !== 401) st.error = (e as Error).message || 'Could not load devices.';
    } finally {
      st.loaded = true;
    }
  });

  useVisibleTask$(async () => {
    await load();
  });

  if (!st.loaded) {
    return <main class="wrap section"><p class="muted">Loading…</p></main>;
  }

  if (!st.loggedIn) {
    return (
      <main class="wrap section">
        <h1>Devices</h1>
        <p class="lead">You need to sign in to manage your devices.</p>
        <a class="btn" style="margin-top:16px" href="/account/">Sign in →</a>
      </main>
    );
  }

  // Group active devices by pool to show seat usage per license.
  const activeByPool: Record<string, number> = {};
  for (const d of st.devices) {
    if (d.state === 'active' && d.pool) activeByPool[d.pool] = (activeByPool[d.pool] ?? 0) + 1;
  }

  return (
    <main class="wrap section">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h1>Devices</h1>
        <a class="note" href="/account/">← My account</a>
      </div>
      <p class="lead">Devices activated on your {store.value.name} licenses across every platform.</p>

      <div class="summary" style="margin-top:20px;padding:16px;display:flex;gap:24px;flex-wrap:wrap">
        {(['computer', 'mobile', 'watch'] as const).map((pool) => (
          <div class="line" key={pool} style="display:flex;flex-direction:column;gap:2px">
            <span class="muted" style="font-size:12px">{POOL_LABEL[pool]}</span>
            <span>
              {POOL_CAP[pool] === Infinity
                ? `${activeByPool[pool] ?? 0} active (unlimited)`
                : `${activeByPool[pool] ?? 0} of ${POOL_CAP[pool]} used`}
            </span>
          </div>
        ))}
      </div>
      <p class="note" style="margin-top:8px">
        Seat caps shown above are the standard allowance. If your license is grandfathered as unlimited, the
        server will not block additional activations even where this shows "of 2".
      </p>

      {st.error && <p class="err" style="margin-top:16px">{st.error}</p>}

      {st.devices.length === 0 && <p class="lead" style="margin-top:24px">No devices activated yet.</p>}

      <div class="grid" style="margin-top:24px;grid-template-columns:1fr">
        {st.devices.map((d) => <DeviceRow key={d.id} st={st} id={d.id} />)}
      </div>
    </main>
  );
});

/** One device card. Its actions read the device by id from the page state (no list item crosses a $ boundary). */
const DeviceRow = component$<{ st: DevicesState; id: string }>(({ st, id }) => {
  const startRename = $(() => {
    st.renamingId = id;
    st.renameValue = st.devices.find((x) => x.id === id)?.label ?? '';
  });

  const saveRename = $(async () => {
    if (!st.renameValue.trim()) return;
    st.busy = id;
    st.error = '';
    try {
      await renameDevice(id, st.renameValue.trim());
      const dev = st.devices.find((d) => d.id === id);
      if (dev) dev.label = st.renameValue.trim();
      st.renamingId = '';
    } catch (e) {
      st.error = (e as Error).message || 'Rename failed.';
    } finally {
      st.busy = '';
    }
  });

  // "Remove" is the only destructive action this page offers. There is no
  // separate "reassign" — the backend has no reassign endpoint. Remote
  // removal tombstones the row, bumps its generation, and frees the pool
  // slot transactionally; that IS how a lost device is
  // recovered and how a seat gets moved to a different device.
  const confirmRemove = $(async () => {
    st.busy = id;
    st.error = '';
    try {
      await removeDevice(id);
      st.devices = st.devices.filter((d) => d.id !== id);
      st.confirmRemoveId = '';
    } catch (e) {
      st.error = (e as Error).message || 'Remove failed — nothing was changed.';
    } finally {
      st.busy = '';
    }
  });

  const d = st.devices.find((x) => x.id === id);
  if (!d) return null;
  const brand = variantByKey(d.appKey);
  const isRemoved = d.state !== 'active';
  return (
    <div class="card" style={isRemoved ? 'opacity:.6' : undefined}>
      <div style="display:flex;justify-content:space-between;align-items:start;gap:16px;flex-wrap:wrap">
        <div>
          {st.renamingId === d.id ? (
            <div style="display:flex;gap:8px;align-items:center">
              <input
                type="text"
                value={st.renameValue}
                onInput$={(e) => (st.renameValue = (e.target as HTMLInputElement).value)}
                style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;font:inherit"
              />
              <button class="btn" disabled={st.busy === d.id} onClick$={saveRename}>Save</button>
              <button class="btn ghost" onClick$={() => (st.renamingId = '')}>Cancel</button>
            </div>
          ) : (
            <h2 style="display:flex;align-items:center;gap:8px">
              {d.label ?? <span class="muted">(unnamed device)</span>}
              {!isRemoved && (
                <button
                  class="btn ghost"
                  style="font-size:11px;padding:4px 10px"
                  onClick$={startRename}
                >
                  Rename
                </button>
              )}
            </h2>
          )}
          <p class="note" style="margin-top:4px">
            {brand?.name ?? d.appKey} · {d.platform ? (PLATFORM_LABEL[d.platform] ?? d.platform) : 'platform unknown'}
            {' · '}
            {d.pool ? (POOL_LABEL[d.pool] ?? d.pool) : 'pool unknown'}
          </p>
          <p class="note" style="margin-top:2px">
            State: {d.state} · Last seen: {fmtDateTime(d.lastSeenAt)} · Activated: {fmtDateTime(d.activatedAt)}
          </p>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
          {isRemoved ? (
            <span class="note">Removed</span>
          ) : st.confirmRemoveId === d.id ? (
            <div style="text-align:right">
              <p class="note" style="margin-top:0;max-width:220px">
                This frees the seat for another device. This device will lose Pro immediately.
              </p>
              <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
                <button class="btn" disabled={st.busy === d.id} onClick$={confirmRemove}>
                  {st.busy === d.id ? 'Removing…' : 'Confirm remove'}
                </button>
                <button class="btn ghost" onClick$={() => (st.confirmRemoveId = '')}>Cancel</button>
              </div>
            </div>
          ) : (
            <button class="btn ghost" onClick$={() => (st.confirmRemoveId = id)}>Remove</button>
          )}
        </div>
      </div>
    </div>
  );
});

export const head: DocumentHead = ({ resolveValue }) => {
  const store = resolveValue(useHostVariant);
  return { title: `Devices — ${store.name}`, meta: [{ name: 'robots', content: 'noindex, follow' }] };
};
