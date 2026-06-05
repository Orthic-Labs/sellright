import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState } from '../components/ui';
import { dateTime } from '../lib/format';

interface Event { actor: string | null; entity: string; entityId: string | null; action: string; fromState: string | null; toState: string | null; at: string; }

export default function Activity() {
  const { store } = useAuth();
  const { data, isLoading, error } = useQuery({ queryKey: ['activity', store?.slug], queryFn: () => api.get<{ items: Event[] }>('/activity?limit=150') });
  return (
    <>
      <PageHeader title="Activity log" subtitle="Recent admin actions across this store." />
      <div className="card overflow-hidden">
        {isLoading ? <Loading /> : error ? <ErrorNote message={(error as Error).message} /> : !data || data.items.length === 0 ? <EmptyState title="No activity yet" /> : (
          <ul className="divide-y divide-gray-100">
            {data.items.map((e, i) => (
              <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-gray-300 shrink-0" />
                <div className="flex-1">
                  <span className="font-medium capitalize">{e.action.replace(/_/g, ' ')}</span> <span className="text-gray-500">{e.entity}</span>
                  {e.toState && <span className="text-gray-400"> → {e.toState}</span>}
                </div>
                <span className="text-xs text-gray-400 whitespace-nowrap">{e.actor ?? 'system'} · {dateTime(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
