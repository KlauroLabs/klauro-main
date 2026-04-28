export async function GET(_request: Request, context: { params: { id: string } }) {
  return Response.json({ id: context.params.id, name: 'Ada' });
}
