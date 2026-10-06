import express from 'express';
const app = express();
const router = express.Router();

function requireAuth(req: any, res: any, next: any) { next(); }
function open(req: any, res: any) { res.end(); }

router.get('/health', open);
router.use(requireAuth);
router.get('/users', (req, res) => res.json([]));
router.post('/users', open);
app.use('/api', router);
