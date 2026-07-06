import { Request, Response } from 'express';
import { contractService } from '../services/contract.service';

export async function listContracts(req: Request, res: Response): Promise<void> {
  const items = await contractService.list();
  res.json(items);
}

export async function getContract(req: Request, res: Response): Promise<void> {
  const item = await contractService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Contract not found' });
    return;
  }
  res.json(item);
}

export async function createContract(req: Request, res: Response): Promise<void> {
  const created = await contractService.create(req.body);
  res.status(201).json(created);
}

export async function updateContract(req: Request, res: Response): Promise<void> {
  const updated = await contractService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Contract not found' });
    return;
  }
  res.json(updated);
}

export async function removeContract(req: Request, res: Response): Promise<void> {
  const removed = await contractService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
