import React from 'react';
import type { Contact } from '../types/contact';

interface ContactCardProps {
  item: Contact;
  onSelect?: (id: string) => void;
}

export function ContactCard({ item, onSelect }: ContactCardProps): JSX.Element {
  return (
    <div className="contact-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
