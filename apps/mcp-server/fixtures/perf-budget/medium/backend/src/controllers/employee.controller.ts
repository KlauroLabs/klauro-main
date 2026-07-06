import { Request, Response } from 'express';
import { employeeService } from '../services/employee.service';

export async function listEmployees(req: Request, res: Response): Promise<void> {
  const items = await employeeService.list();
  res.json(items);
}

export async function getEmployee(req: Request, res: Response): Promise<void> {
  const item = await employeeService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }
  res.json(item);
}

export async function createEmployee(req: Request, res: Response): Promise<void> {
  const created = await employeeService.create(req.body);
  res.status(201).json(created);
}

export async function updateEmployee(req: Request, res: Response): Promise<void> {
  const updated = await employeeService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }
  res.json(updated);
}

export async function removeEmployee(req: Request, res: Response): Promise<void> {
  const removed = await employeeService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
