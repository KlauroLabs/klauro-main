import React from 'react';
import { useContacts } from '../hooks/useContacts';
import { ContactCard } from '../components/ContactCard';

export function ContactPage(): JSX.Element {
  const { items, loading } = useContacts();

  if (loading) {
    return <div>Loading contacts...</div>;
  }

  return (
    <section className="contact-page">
      <h1>Contacts</h1>
      <div className="contact-list">
        {items.map((item) => (
          <ContactCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
