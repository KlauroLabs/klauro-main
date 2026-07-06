import { Router } from 'express';
import {
  listSettings,
  getSetting,
  createSetting,
  updateSetting,
  removeSetting,
} from '../controllers/setting.controller';

export const settingRouter = Router();

settingRouter.get('/', listSettings);
settingRouter.get('/:id', getSetting);
settingRouter.post('/', createSetting);
settingRouter.put('/:id', updateSetting);
settingRouter.delete('/:id', removeSetting);
