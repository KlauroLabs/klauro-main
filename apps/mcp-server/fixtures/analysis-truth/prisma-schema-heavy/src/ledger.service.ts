import { PrismaClient } from '@prisma/client';

export class LedgerService {
  constructor(private readonly prisma: PrismaClient) {}

  recordTransaction(accountId: string, amount: number) {
    return this.prisma.transaction.create({
      data: {
        id: `${accountId}-${amount}`,
        accountId,
        amount
      }
    });
  }
}
