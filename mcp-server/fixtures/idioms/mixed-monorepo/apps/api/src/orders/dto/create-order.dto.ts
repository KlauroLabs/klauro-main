import { z } from 'zod';

export const CreateOrderDto = z.object({
  tenantId: z.string(),
  totalCents: z.number().int().positive(),
});
