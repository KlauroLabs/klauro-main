import React from 'react';
import { useDevices } from '../hooks/useDevices';
import { DeviceCard } from '../components/DeviceCard';

export function DevicePage(): JSX.Element {
  const { items, loading } = useDevices();

  if (loading) {
    return <div>Loading devices...</div>;
  }

  return (
    <section className="device-page">
      <h1>Devices</h1>
      <div className="device-list">
        {items.map((item) => (
          <DeviceCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
