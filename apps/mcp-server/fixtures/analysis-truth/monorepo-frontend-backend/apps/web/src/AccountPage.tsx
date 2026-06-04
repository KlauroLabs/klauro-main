import { useEffect, useState } from 'react';

export function AccountPage({ accountId }: { accountId: string }) {
  const [account, setAccount] = useState<{ id: string; balance: number } | null>(null);

  useEffect(() => {
    fetch(`/api/accounts/${accountId}`)
      .then(response => response.json())
      .then(setAccount);
  }, [accountId]);

  return <output>{account?.balance ?? 'loading'}</output>;
}
