import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge, Spinner } from '../components/ui';

interface LocationRow {
  id: string;
  name: string;
  code: string;
  isDefault: boolean;
}

export default function LocationsPage() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [isDefault, setIsDefault] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['locations', store?.slug],
    queryFn: () => api.get<{ items: LocationRow[] }>('/locations'),
  });

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/locations', { name, code, isDefault }),
    onSuccess: () => {
      setName('');
      setCode('');
      setIsDefault(false);
      setCreating(false);
      qc.invalidateQueries({ queryKey: ['locations', store?.slug] });
    },
  });

  return (
    <>
      <PageHeader
        title="Locations"
        subtitle="Inventory locations for stock tracking."
        actions={
          <button className="btn-primary" onClick={() => setCreating((v) => !v)}>
            <Plus size={16} /> Add location
          </button>
        }
      />

      {creating && (
        <form
          className="card p-4 mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
        >
          <div className="flex-1 min-w-40">
            <label className="label">Name</label>
            <input
              className="input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Main Warehouse"
            />
          </div>
          <div className="w-36">
            <label className="label">Code</label>
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. WH-01"
            />
          </div>
          <div className="flex items-center gap-2 pb-1">
            <input
              id="loc-default"
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label htmlFor="loc-default" className="text-sm text-gray-700 select-none">Default</label>
          </div>
          <button
            className="btn-primary"
            disabled={!name.trim() || !code.trim() || create.isPending}
          >
            {create.isPending ? <Spinner className="text-white" /> : 'Create'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      )}

      {create.error && (
        <div className="mb-4">
          <ErrorNote message={(create.error as Error).message} />
        </div>
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <Loading />
        ) : error ? (
          <ErrorNote message={(error as Error).message} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState title="No locations yet" hint="Add one to start tracking inventory per location." />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Name</th>
                <th className="th">Code</th>
                <th className="th">Default</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((loc) => (
                <tr key={loc.id}>
                  <td className="td font-medium">{loc.name}</td>
                  <td className="td font-mono text-xs text-gray-500">{loc.code}</td>
                  <td className="td">{loc.isDefault && <Badge value="active" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
