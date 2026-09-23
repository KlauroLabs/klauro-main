export const records = {
  async remove(id: string) {
    return fetch(`/records/${id}`, { method: 'DELETE' });
  },
};

export function RemoveRecord(id: string) {
  return records.remove(id);
}
