// damned/store/src/services/ListmonkService.ts
// SERVER-ONLY — never import from component$ or browser code.

export interface ListmonkConfig {
  baseUrl: string;
  user: string;
  token: string;
  brandListId: number;
  brandName: string;
}

export interface ListmonkSubscriber {
  id: number;
  uuid: string;
  email: string;
  name: string;
  brandListStatus: 'confirmed' | 'unconfirmed' | 'unsubscribed' | 'not_subscribed';
}

interface RawListMembership {
  id: number;
  subscription_status: 'confirmed' | 'unconfirmed' | 'unsubscribed';
}

interface RawSubscriber {
  id: number;
  uuid: string;
  email: string;
  name: string;
  status: 'enabled' | 'disabled' | 'blocklisted';
  lists: RawListMembership[];
}

export class ListmonkService {
  constructor(private config: ListmonkConfig) {}

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.config.user}:${this.config.token}`).toString('base64');
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Listmonk ${init?.method || 'GET'} ${path} → ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async lookupByUuid(uuid: string): Promise<ListmonkSubscriber | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      return null;
    }
    const query = encodeURIComponent(`subscribers.uuid = '${uuid}'`);
    const data = await this.request<{ data: { results: RawSubscriber[]; total: number } }>(
      `/api/subscribers?query=${query}&per_page=1`,
    );
    const raw = data.data.results[0];
    if (!raw) return null;

    const brandList = raw.lists.find((l) => l.id === this.config.brandListId);
    return {
      id: raw.id,
      uuid: raw.uuid,
      email: raw.email,
      name: raw.name,
      brandListStatus: brandList ? brandList.subscription_status : 'not_subscribed',
    };
  }

  /** Unsubscribe from THIS brand's list only. Never touches other brand lists. */
  async unsubscribeFromBrand(subscriberId: number): Promise<void> {
    await this.request('/api/subscribers/lists', {
      method: 'PUT',
      body: JSON.stringify({
        ids: [subscriberId],
        action: 'unsubscribe',
        target_list_ids: [this.config.brandListId],
      }),
    });
  }

  /** Confirm subscription to this brand's list. */
  async confirmSubscription(subscriberId: number): Promise<void> {
    await this.request('/api/subscribers/lists', {
      method: 'PUT',
      body: JSON.stringify({
        ids: [subscriberId],
        action: 'add',
        target_list_ids: [this.config.brandListId],
        status: 'confirmed',
      }),
    });
  }
}

export function getListmonkService(): ListmonkService {
  const baseUrl = process.env.LISTMONK_INTERNAL_URL;
  const user = process.env.LISTMONK_ADMIN_USER;
  const token = process.env.LISTMONK_ADMIN_TOKEN;
  const brandListId = Number(process.env.LISTMONK_LIST_ID_DAMNED);
  if (!baseUrl || !user || !token || !Number.isFinite(brandListId)) {
    throw new Error('Listmonk env vars missing: LISTMONK_INTERNAL_URL, LISTMONK_ADMIN_USER, LISTMONK_ADMIN_TOKEN, LISTMONK_LIST_ID_DAMNED');
  }
  return new ListmonkService({ baseUrl, user, token, brandListId, brandName: 'Damned Designs' });
}
