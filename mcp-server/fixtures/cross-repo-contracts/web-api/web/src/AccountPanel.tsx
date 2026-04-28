import React, { useEffect, useState } from 'react';

interface Account {
  id: string;
  name: string;
  balance: number;
}

export function AccountPanel({ accountId }: { accountId: string }) {
  const [account, setAccount] = useState<Account | null>(null);

  useEffect(() => {
    let active = true;

    async function loadAccount() {
      const response = await fetch(`/api/accounts/${accountId}`);
      const body = await response.json();
      if (active) setAccount(body);
    }

    loadAccount();

    return () => {
      active = false;
    };
  }, [accountId]);

  if (!account) return <section>Loading</section>;

  return (
    <section>
      <h1>{account.name}</h1>
      <strong>{account.balance}</strong>
    </section>
  );
}
