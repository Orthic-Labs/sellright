import { useAuth } from '../auth';
import { PageHeader } from '../components/ui';

export default function SettingsPage() {
  const { me, store, stores, logout } = useAuth();
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid lg:grid-cols-2 gap-5">
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-3">Account</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Email</dt><dd className="font-medium">{me?.email}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Stores</dt><dd className="font-medium">{stores.length}</dd></div>
          </dl>
          <button className="btn-ghost mt-4" onClick={() => void logout()}>Sign out</button>
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-3">Current store</h2>
          {store && (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">Name</dt><dd className="font-medium">{store.name}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Handle</dt><dd className="font-mono text-xs">{store.slug}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Currency</dt><dd className="font-medium">{store.currency}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Your role</dt><dd className="font-medium capitalize">{store.role}</dd></div>
            </dl>
          )}
        </div>

        <div className="card p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold mb-3">Your stores</h2>
          <table className="w-full">
            <thead><tr><th className="th">Store</th><th className="th">Handle</th><th className="th">Currency</th><th className="th">Role</th></tr></thead>
            <tbody>
              {stores.map((s) => (
                <tr key={s.slug} className="border-t border-gray-100">
                  <td className="td font-medium">{s.name}</td>
                  <td className="td font-mono text-xs text-gray-500">{s.slug}</td>
                  <td className="td">{s.currency}</td>
                  <td className="td capitalize">{s.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
