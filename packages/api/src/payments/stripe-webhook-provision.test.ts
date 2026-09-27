import { describe, expect, it, vi } from 'vitest';
import { ensureStripeWebhook, webhookMetadataValue, MANAGED_BY_KEY, type StripeWebhookClient } from './stripe-webhook-provision.js';

const url = 'https://api.example.com/v1/webhooks/stripe';
const storeId = 'store-1';
const mode = 'test' as const;

function makeClient(existing: Array<{ id: string; url: string; metadata?: Record<string, string> }> = []): StripeWebhookClient & {
  create: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn().mockResolvedValue({ data: existing });
  const create = vi.fn().mockResolvedValue({ id: 'we_new', url, secret: 'whsec_new' });
  const del = vi.fn().mockResolvedValue({});
  return { webhookEndpoints: { list, create, del }, list, create, del } as unknown as StripeWebhookClient & { create: typeof create; del: typeof del; list: typeof list };
}

describe('ensureStripeWebhook', () => {
  it('creates a new endpoint when none exists, returning the secret', async () => {
    const client = makeClient([]);
    const result = await ensureStripeWebhook(client, { storeId, mode, url, hasStoredSecret: () => false });
    expect(result).toEqual({ endpointId: 'we_new', newSecret: 'whsec_new', created: true, recreated: false });
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      url, metadata: { [MANAGED_BY_KEY]: webhookMetadataValue(storeId, mode) },
    }));
    expect(client.del).not.toHaveBeenCalled();
  });

  it('is idempotent: finds its own endpoint by url+metadata and does nothing when the secret is already stored', async () => {
    const client = makeClient([{ id: 'we_existing', url, metadata: { [MANAGED_BY_KEY]: webhookMetadataValue(storeId, mode) } }]);
    const result = await ensureStripeWebhook(client, { storeId, mode, url, hasStoredSecret: (id) => id === 'we_existing' });
    expect(result).toEqual({ endpointId: 'we_existing', created: false, recreated: false });
    expect(client.create).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });

  it('recreates when a matching endpoint exists but the secret was lost', async () => {
    const client = makeClient([{ id: 'we_existing', url, metadata: { [MANAGED_BY_KEY]: webhookMetadataValue(storeId, mode) } }]);
    const result = await ensureStripeWebhook(client, { storeId, mode, url, hasStoredSecret: () => false });
    expect(client.del).toHaveBeenCalledWith('we_existing');
    expect(client.create).toHaveBeenCalled();
    expect(result).toEqual({ endpointId: 'we_new', newSecret: 'whsec_new', created: false, recreated: true });
  });

  it('ignores an endpoint at the same url for a DIFFERENT store/mode (never treats it as its own)', async () => {
    const client = makeClient([{ id: 'we_other', url, metadata: { [MANAGED_BY_KEY]: webhookMetadataValue('other-store', mode) } }]);
    const result = await ensureStripeWebhook(client, { storeId, mode, url, hasStoredSecret: () => true });
    expect(client.del).not.toHaveBeenCalled();
    expect(client.create).toHaveBeenCalled();
    expect(result.created).toBe(true);
  });

  it('ignores an unmanaged endpoint at the same url (no sellright_managed metadata)', async () => {
    const client = makeClient([{ id: 'we_unmanaged', url }]);
    const result = await ensureStripeWebhook(client, { storeId, mode, url, hasStoredSecret: () => true });
    expect(client.del).not.toHaveBeenCalled();
    expect(client.create).toHaveBeenCalled();
    expect(result.created).toBe(true);
  });

  it('throws if Stripe create somehow omits the secret', async () => {
    const client = makeClient([]);
    client.create.mockResolvedValue({ id: 'we_new', url });
    await expect(ensureStripeWebhook(client, { storeId, mode, url, hasStoredSecret: () => false })).rejects.toThrow(/signing secret/);
  });
});
